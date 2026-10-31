use gpui::{Bounds, Pixels};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct OverlayRect {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
}

impl OverlayRect {
    pub(crate) fn from_bounds(bounds: Bounds<Pixels>) -> Self {
        Self {
            x: bounds.origin.x.as_f32(),
            y: bounds.origin.y.as_f32(),
            width: bounds.size.width.as_f32().max(0.0),
            height: bounds.size.height.as_f32().max(0.0),
        }
    }

    fn intersects(self, other: Self) -> bool {
        self.x < other.x + other.width
            && other.x < self.x + self.width
            && self.y < other.y + other.height
            && other.y < self.y + self.height
    }
}

#[derive(Default)]
pub(crate) struct OverlayRegistry {
    entries: Vec<(String, OverlayRect)>,
}

impl OverlayRegistry {
    pub(crate) fn clear(&mut self) {
        self.entries.clear();
    }

    pub(crate) fn replace(&mut self, id: impl Into<String>, bounds: OverlayRect) {
        let id = id.into();
        if let Some((_, current)) = self.entries.iter_mut().find(|(key, _)| *key == id) {
            *current = bounds;
        } else {
            self.entries.push((id, bounds));
        }
    }

    pub(crate) fn intersects_bounds(&self, bounds: Bounds<Pixels>) -> bool {
        let target = OverlayRect::from_bounds(bounds);
        self.entries
            .iter()
            .any(|(_, overlay)| overlay.intersects(target))
    }
}

#[cfg(test)]
mod tests {
    use super::{OverlayRect, OverlayRegistry};

    fn rect(x: f32, y: f32, width: f32, height: f32) -> OverlayRect {
        OverlayRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn detects_only_positive_area_intersection() {
        let overlay = rect(10.0, 10.0, 100.0, 80.0);
        assert!(overlay.intersects(rect(50.0, 20.0, 10.0, 10.0)));
        assert!(!overlay.intersects(rect(110.0, 10.0, 20.0, 20.0)));
        assert!(!overlay.intersects(rect(10.0, 90.0, 20.0, 20.0)));
    }

    #[test]
    fn replacing_an_overlay_does_not_leave_stale_geometry() {
        let mut registry = OverlayRegistry::default();
        registry.replace("dialog", rect(0.0, 0.0, 100.0, 100.0));
        registry.replace("dialog", rect(300.0, 300.0, 20.0, 20.0));
        assert_eq!(registry.entries.len(), 1);
        assert!(!registry
            .entries
            .iter()
            .any(|(_, bounds)| bounds.intersects(rect(20.0, 20.0, 10.0, 10.0))));
    }
}
