use cli_manager_term_engine::{Cell, Color, Colors, NamedColor, Rgb};
use gpui::{App, Font, Global, SharedString, TextRun};
use std::{
    cell::RefCell,
    collections::{hash_map::RandomState, HashMap},
    hash::{BuildHasher, Hash, Hasher},
    ops::Range,
    rc::Rc,
    sync::Arc,
};

const MAX_ENTRIES: usize = 512;
const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub(super) struct PreparedText {
    pub(super) text: SharedString,
    pub(super) runs: Vec<TextRun>,
}

#[derive(Default, Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct RowDecorations {
    pub(super) cursor: Option<usize>,
    pub(super) selection: Option<Range<usize>>,
    pub(super) urls: Vec<Range<usize>>,
    pub(super) search: Vec<Range<usize>>,
}

struct CachedCell {
    character: char,
    foreground: Color,
    background: Color,
    flags: u16,
    combining: Box<[char]>,
}

impl CachedCell {
    fn new(cell: &Cell) -> Self {
        Self {
            character: cell.c,
            foreground: cell.fg,
            background: cell.bg,
            flags: cell.flags.bits(),
            combining: cell.zerowidth().unwrap_or_default().into(),
        }
    }

    fn matches(&self, cell: &Cell) -> bool {
        self.character == cell.c
            && self.foreground == cell.fg
            && self.background == cell.bg
            && self.flags == cell.flags.bits()
            && self.combining.as_ref() == cell.zerowidth().unwrap_or_default()
    }
}

pub(super) struct RowContext {
    palette: Arc<[Option<Rgb>]>,
    font: Font,
    fingerprint: u64,
}

struct Entry {
    cells: Box<[CachedCell]>,
    palette: Arc<[Option<Rgb>]>,
    font: Font,
    decorations: RowDecorations,
    text: PreparedText,
    last_use: u64,
    bytes: usize,
}

impl Entry {
    fn matches(&self, cells: &[Cell], context: &RowContext, decorations: &RowDecorations) -> bool {
        self.font == context.font
            && self.palette == context.palette
            && self.decorations == *decorations
            && self.cells.len() == cells.len()
            && self
                .cells
                .iter()
                .zip(cells)
                .all(|(previous, current)| previous.matches(current))
    }
}

#[derive(Default, Clone, Copy, Debug)]
pub(crate) struct RowCacheStats {
    pub(crate) hits: u64,
    pub(crate) misses: u64,
    pub(crate) evictions: u64,
    pub(crate) bypasses: u64,
    pub(crate) entries: usize,
    pub(crate) retained_bytes: usize,
}

#[derive(Default)]
pub(crate) struct RowPreparationCache {
    buckets: HashMap<u64, Vec<Entry>>,
    hash_builder: RandomState,
    clock: u64,
    stats: RowCacheStats,
    last_palette: Option<Arc<[Option<Rgb>]>>,
    palette_fingerprint: u64,
}

impl RowPreparationCache {
    pub(super) fn context(&mut self, colors: &Colors, font: Font) -> RowContext {
        let count = NamedColor::DimForeground as usize + 1;
        let matches = self.last_palette.as_ref().is_some_and(|palette| {
            palette.len() == count
                && palette
                    .iter()
                    .enumerate()
                    .all(|(index, color)| *color == colors[index])
        });
        if !matches {
            self.last_palette = Some((0..count).map(|index| colors[index]).collect());
            let mut hasher = self.hash_builder.build_hasher();
            for index in 0..count {
                colors[index].is_some().hash(&mut hasher);
                if let Some(color) = colors[index] {
                    [color.r, color.g, color.b].hash(&mut hasher);
                }
            }
            self.palette_fingerprint = hasher.finish();
        }
        let palette = self.last_palette.as_ref().unwrap().clone();
        let mut hasher = self.hash_builder.build_hasher();
        font.hash(&mut hasher);
        self.palette_fingerprint.hash(&mut hasher);
        RowContext {
            palette,
            font,
            fingerprint: hasher.finish(),
        }
    }

    pub(super) fn get_or_prepare(
        &mut self,
        cells: &[Cell],
        context: &RowContext,
        decorations: RowDecorations,
        prepare: impl FnOnce() -> PreparedText,
    ) -> PreparedText {
        let mut hasher = self.hash_builder.build_hasher();
        context.fingerprint.hash(&mut hasher);
        decorations.hash(&mut hasher);
        cells.len().hash(&mut hasher);
        let mut content = cells.len() as u64;
        for cell in cells {
            content = content.rotate_left(7) ^ cell.c as u64 ^ ((cell.flags.bits() as u64) << 32);
        }
        content.hash(&mut hasher);
        self.get_by_fingerprint(hasher.finish(), cells, context, decorations, prepare)
    }

    fn get_by_fingerprint(
        &mut self,
        fingerprint: u64,
        cells: &[Cell],
        context: &RowContext,
        decorations: RowDecorations,
        prepare: impl FnOnce() -> PreparedText,
    ) -> PreparedText {
        self.clock = self.clock.wrapping_add(1);
        if let Some(entry) = self.buckets.get_mut(&fingerprint).and_then(|entries| {
            entries
                .iter_mut()
                .find(|entry| entry.matches(cells, context, &decorations))
        }) {
            entry.last_use = self.clock;
            self.stats.hits += 1;
            return entry.text.clone();
        }
        self.stats.misses += 1;
        let text = prepare();
        let bytes = retained_bytes(cells, context, &decorations, &text);
        if bytes > MAX_BYTES {
            self.stats.bypasses += 1;
            return text;
        }
        while self.stats.entries >= MAX_ENTRIES
            || self.stats.retained_bytes.saturating_add(bytes) > MAX_BYTES
        {
            self.evict_oldest();
        }
        self.buckets.entry(fingerprint).or_default().push(Entry {
            cells: cells.iter().map(CachedCell::new).collect(),
            palette: context.palette.clone(),
            font: context.font.clone(),
            decorations,
            text: text.clone(),
            last_use: self.clock,
            bytes,
        });
        self.stats.entries += 1;
        self.stats.retained_bytes += bytes;
        text
    }

    fn evict_oldest(&mut self) {
        let Some((fingerprint, index)) = self
            .buckets
            .iter()
            .flat_map(|(fingerprint, entries)| {
                entries
                    .iter()
                    .enumerate()
                    .map(move |(index, entry)| (*fingerprint, index, entry.last_use))
            })
            .min_by_key(|(_, _, last_use)| *last_use)
            .map(|(fingerprint, index, _)| (fingerprint, index))
        else {
            return;
        };
        let entries = self.buckets.get_mut(&fingerprint).unwrap();
        let entry = entries.swap_remove(index);
        self.stats.entries -= 1;
        self.stats.retained_bytes -= entry.bytes;
        self.stats.evictions += 1;
        if entries.is_empty() {
            self.buckets.remove(&fingerprint);
        }
    }

    pub(crate) fn stats(&self) -> RowCacheStats {
        self.stats
    }
}

fn retained_bytes(
    cells: &[Cell],
    context: &RowContext,
    decorations: &RowDecorations,
    text: &PreparedText,
) -> usize {
    let font_bytes = std::mem::size_of::<Font>()
        + context.font.family.len()
        + context
            .font
            .features
            .0
            .iter()
            .map(|(name, _)| name.len() + std::mem::size_of::<(String, u32)>())
            .sum::<usize>()
        + context
            .font
            .fallbacks
            .as_ref()
            .map(|fallbacks| {
                fallbacks
                    .fallback_list()
                    .iter()
                    .map(|family| family.len() + std::mem::size_of::<String>())
                    .sum::<usize>()
            })
            .unwrap_or(0);
    std::mem::size_of::<Entry>()
        + cells.len() * std::mem::size_of::<CachedCell>()
        + cells
            .iter()
            .map(|cell| std::mem::size_of_val(cell.zerowidth().unwrap_or_default()))
            .sum::<usize>()
        + std::mem::size_of_val(context.palette.as_ref())
        + (decorations.urls.capacity() + decorations.search.capacity())
            * std::mem::size_of::<Range<usize>>()
        + text.text.len()
        + text.runs.capacity() * std::mem::size_of::<TextRun>()
        + font_bytes * (text.runs.len() + 1)
}

#[derive(Default, Clone)]
struct SharedRowPreparationCache(Rc<RefCell<RowPreparationCache>>);

impl Global for SharedRowPreparationCache {}

pub(crate) fn shared(cx: &mut App) -> Rc<RefCell<RowPreparationCache>> {
    if cx.try_global::<SharedRowPreparationCache>().is_none() {
        cx.set_global(SharedRowPreparationCache::default());
    }
    cx.global::<SharedRowPreparationCache>().0.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> PreparedText {
        PreparedText {
            text: value.to_owned().into(),
            runs: Vec::new(),
        }
    }

    #[test]
    fn exact_keys_prevent_wrong_reuse_even_with_forced_hash_collision() {
        let mut cache = RowPreparationCache::default();
        let context = cache.context(&Colors::default(), gpui::font("Consolas"));
        let original = [Cell::default()];
        let mut changed = original.clone();
        changed[0].push_zerowidth('\u{301}');
        assert_eq!(
            cache
                .get_by_fingerprint(7, &original, &context, RowDecorations::default(), || text(
                    "first"
                ))
                .text
                .as_ref(),
            "first"
        );
        assert_eq!(
            cache
                .get_by_fingerprint(7, &changed, &context, RowDecorations::default(), || text(
                    "second"
                ))
                .text
                .as_ref(),
            "second"
        );
        assert_eq!(
            cache
                .get_by_fingerprint(
                    7,
                    &original,
                    &context,
                    RowDecorations::default(),
                    || panic!("expected exact match")
                )
                .text
                .as_ref(),
            "first"
        );
        assert_eq!((cache.stats().hits, cache.stats().misses), (1, 2));
    }

    #[test]
    fn font_palette_attributes_and_decorations_select_distinct_entries() {
        let mut cache = RowPreparationCache::default();
        let mut colors = Colors::default();
        let mut cells = [Cell::default()];
        let context = cache.context(&colors, gpui::font("Consolas"));
        cache.get_or_prepare(&cells, &context, RowDecorations::default(), || {
            text("default")
        });
        let decorations = RowDecorations {
            cursor: Some(0),
            ..Default::default()
        };
        cache.get_or_prepare(&cells, &context, decorations, || text("cursor"));
        let context = cache.context(&colors, gpui::font("Other Mono"));
        cache.get_or_prepare(&cells, &context, RowDecorations::default(), || text("font"));
        colors[NamedColor::Foreground] = Some(Rgb { r: 1, g: 2, b: 3 });
        let context = cache.context(&colors, gpui::font("Consolas"));
        cache.get_or_prepare(&cells, &context, RowDecorations::default(), || {
            text("palette")
        });
        cells[0]
            .flags
            .insert(cli_manager_term_engine::CellFlags::BOLD);
        cache.get_or_prepare(&cells, &context, RowDecorations::default(), || text("bold"));
        assert_eq!(cache.stats().misses, 5);
    }

    #[test]
    fn lru_eviction_keeps_recent_entry_and_bounds_retained_memory() {
        let mut cache = RowPreparationCache::default();
        let context = cache.context(&Colors::default(), gpui::font("Consolas"));
        for index in 0..MAX_ENTRIES {
            let cells = [Cell {
                c: char::from_u32(0x1000 + index as u32).unwrap(),
                ..Default::default()
            }];
            cache.get_or_prepare(&cells, &context, RowDecorations::default(), || text("row"));
        }
        let recent = [Cell {
            c: '\u{1000}',
            ..Default::default()
        }];
        cache.get_or_prepare(&recent, &context, RowDecorations::default(), || {
            panic!("miss")
        });
        cache.get_or_prepare(
            &[Cell::default()],
            &context,
            RowDecorations::default(),
            || text("new"),
        );
        cache.get_or_prepare(&recent, &context, RowDecorations::default(), || {
            panic!("recent was evicted")
        });
        assert_eq!(cache.stats().entries, MAX_ENTRIES);
        assert_eq!(cache.stats().evictions, 1);
        assert!(cache.stats().retained_bytes <= MAX_BYTES);
        let oversized = "x".repeat(MAX_BYTES + 1);
        cache.get_or_prepare(
            &[Cell {
                c: 'z',
                ..Default::default()
            }],
            &context,
            RowDecorations::default(),
            || text(&oversized),
        );
        assert_eq!(cache.stats().bypasses, 1);
        assert_eq!(cache.stats().entries, MAX_ENTRIES);
    }

    #[test]
    fn byte_budget_evicts_before_entry_limit_and_color_only_collisions_are_safe() {
        let mut cache = RowPreparationCache::default();
        let context = cache.context(&Colors::default(), gpui::font("Consolas"));
        let mut cell = Cell::default();
        for index in 0..3 {
            cell.fg = Color::Spec(Rgb {
                r: index,
                g: 0,
                b: 0,
            });
            cache.get_or_prepare(&[cell.clone()], &context, RowDecorations::default(), || {
                text(&"x".repeat(MAX_BYTES / 2))
            });
        }
        assert!(cache.stats().evictions >= 2);
        assert_eq!(cache.stats().entries, 1);
        assert!(cache.stats().retained_bytes <= MAX_BYTES);
        let stored = cache.get_or_prepare(&[cell], &context, RowDecorations::default(), || {
            panic!("color-only collision returned or removed the wrong entry")
        });
        assert_eq!(stored.text.len(), MAX_BYTES / 2);
    }
}
