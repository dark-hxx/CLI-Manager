#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum SplitAxis {
    Horizontal,
    Vertical,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum SplitDirection {
    Left,
    Right,
    Up,
    Down,
}

impl SplitDirection {
    fn axis(self) -> SplitAxis {
        match self {
            Self::Left | Self::Right => SplitAxis::Horizontal,
            Self::Up | Self::Down => SplitAxis::Vertical,
        }
    }

    fn new_pane_is_first(self) -> bool {
        matches!(self, Self::Left | Self::Up)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum PaneNode {
    Leaf(u64),
    Split {
        axis: SplitAxis,
        ratio_basis_points: u16,
        first: Box<PaneNode>,
        second: Box<PaneNode>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PaneBounds {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DividerAxis {
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DropZone {
    Center,
    Left,
    Right,
    Top,
    Bottom,
}

impl DropZone {
    pub fn from_local_position(x: f32, y: f32) -> Self {
        let left = x;
        let right = 1.0 - x;
        let top = y;
        let bottom = 1.0 - y;
        let edge = left.min(right).min(top).min(bottom);
        if edge > 0.25 {
            return Self::Center;
        }
        if edge == left {
            Self::Left
        } else if edge == right {
            Self::Right
        } else if edge == top {
            Self::Top
        } else {
            Self::Bottom
        }
    }

    fn direction(self) -> Option<SplitDirection> {
        match self {
            Self::Center => None,
            Self::Left => Some(SplitDirection::Left),
            Self::Right => Some(SplitDirection::Right),
            Self::Top => Some(SplitDirection::Up),
            Self::Bottom => Some(SplitDirection::Down),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PaneTree {
    root: PaneNode,
    active: u64,
    next_id: u64,
}

impl PaneTree {
    pub fn new(first_pane: u64) -> Self {
        assert!(first_pane > 0, "pane IDs must be positive");
        Self {
            root: PaneNode::Leaf(first_pane),
            active: first_pane,
            next_id: first_pane + 1,
        }
    }

    pub fn root(&self) -> &PaneNode {
        &self.root
    }
    pub fn active(&self) -> u64 {
        self.active
    }
    pub fn next_pane_id(&self) -> u64 {
        self.next_id
    }

    pub fn set_active(&mut self, pane: u64) -> bool {
        if contains(&self.root, pane) {
            self.active = pane;
            true
        } else {
            false
        }
    }

    pub fn split_active(&mut self, direction: SplitDirection) -> u64 {
        let old = self.active;
        let new = self.next_id;
        self.next_id = self.next_id.checked_add(1).expect("pane ID exhausted");
        let replacement = split_leaf(
            std::mem::replace(&mut self.root, PaneNode::Leaf(old)),
            old,
            direction,
            new,
        )
        .expect("active pane must be present in pane tree");
        self.root = replacement;
        self.active = new;
        new
    }

    pub fn move_pane(&mut self, source: u64, target: u64, zone: DropZone) -> bool {
        if source == target || !contains(&self.root, source) || !contains(&self.root, target) {
            return false;
        }
        let Some((root, _sibling)) = remove(&self.root, source) else {
            return false;
        };
        self.root = root;
        if let Some(direction) = zone.direction() {
            self.root = split_leaf(self.root.clone(), target, direction, source)
                .expect("drop target must remain in pane tree");
            self.active = source;
            true
        } else {
            self.active = target;
            true
        }
    }

    pub fn close_active(&mut self) -> Option<u64> {
        self.close(self.active)
    }

    /// Adjusts the nearest split containing the active pane.
    /// Positive values expand the active pane toward the right or down.
    pub fn resize_active(&mut self, delta_basis_points: i16) -> bool {
        resize_nearest(&mut self.root, self.active, delta_basis_points)
    }

    pub fn close(&mut self, pane: u64) -> Option<u64> {
        if matches!(self.root, PaneNode::Leaf(_)) {
            return None;
        }
        let (replacement, sibling) = remove(&self.root, pane)?;
        self.root = replacement;
        if self.active == pane {
            self.active = sibling;
        }
        Some(self.active)
    }

    pub fn leaves(&self) -> Vec<u64> {
        let mut result = Vec::new();
        collect_leaves(&self.root, &mut result);
        result
    }

    /// Returns normalized 0..=10000 bounds for each leaf in visual order.
    /// Using integer basis points keeps persistence deterministic and leaves
    /// pixel rounding to the GPUI layout layer.
    pub fn layout(&self) -> Vec<(u64, PaneBounds)> {
        let mut result = Vec::new();
        layout_node(
            &self.root,
            PaneBounds {
                x: 0,
                y: 0,
                width: 10_000,
                height: 10_000,
            },
            &mut result,
        );
        result
    }

    /// Finds the outermost split divider under a normalized 0..=10000 point.
    pub fn divider_at(&self, x: u16, y: u16, tolerance: u16) -> Option<DividerAxis> {
        divider_at_node(
            &self.root,
            PaneBounds {
                x: 0,
                y: 0,
                width: 10_000,
                height: 10_000,
            },
            x,
            y,
            tolerance,
        )
    }

    /// Adjusts the split whose divider was hit by the pointer. The delta uses
    /// the same basis-point coordinate system as persisted ratios.
    pub fn resize_divider_at(
        &mut self,
        x: u16,
        y: u16,
        delta_basis_points: i16,
        tolerance: u16,
    ) -> bool {
        resize_divider_node(
            &mut self.root,
            PaneBounds {
                x: 0,
                y: 0,
                width: 10_000,
                height: 10_000,
            },
            x,
            y,
            delta_basis_points,
            tolerance,
        )
    }
}

fn contains(node: &PaneNode, pane: u64) -> bool {
    match node {
        PaneNode::Leaf(id) => *id == pane,
        PaneNode::Split { first, second, .. } => contains(first, pane) || contains(second, pane),
    }
}

fn resize_nearest(node: &mut PaneNode, target: u64, delta: i16) -> bool {
    let PaneNode::Split {
        axis: _,
        ratio_basis_points,
        first,
        second,
    } = node
    else {
        return false;
    };
    if contains(first, target) {
        if resize_nearest(first, target, delta) {
            return true;
        }
        *ratio_basis_points = ((*ratio_basis_points as i16 + delta).clamp(1_000, 9_000)) as u16;
        return true;
    }
    if contains(second, target) {
        if resize_nearest(second, target, delta) {
            return true;
        }
        *ratio_basis_points = ((*ratio_basis_points as i16 - delta).clamp(1_000, 9_000)) as u16;
        return true;
    }
    false
}

fn split_leaf(
    node: PaneNode,
    target: u64,
    direction: SplitDirection,
    new: u64,
) -> Option<PaneNode> {
    match node {
        PaneNode::Leaf(id) if id == target => {
            let old = PaneNode::Leaf(id);
            let fresh = PaneNode::Leaf(new);
            let (first, second) = if direction.new_pane_is_first() {
                (fresh, old)
            } else {
                (old, fresh)
            };
            Some(PaneNode::Split {
                axis: direction.axis(),
                ratio_basis_points: 5000,
                first: Box::new(first),
                second: Box::new(second),
            })
        }
        PaneNode::Leaf(_) => Some(node),
        PaneNode::Split {
            axis,
            ratio_basis_points,
            first,
            second,
        } => {
            let first = split_leaf(*first, target, direction, new)?;
            let second = split_leaf(*second, target, direction, new)?;
            Some(PaneNode::Split {
                axis,
                ratio_basis_points,
                first: Box::new(first),
                second: Box::new(second),
            })
        }
    }
}

fn remove(node: &PaneNode, target: u64) -> Option<(PaneNode, u64)> {
    match node {
        PaneNode::Leaf(_) => None,
        PaneNode::Split { first, second, .. } => {
            if matches!(first.as_ref(), PaneNode::Leaf(id) if *id == target) {
                return Some((second.as_ref().clone(), first_leaf(second)));
            }
            if matches!(second.as_ref(), PaneNode::Leaf(id) if *id == target) {
                return Some((first.as_ref().clone(), first_leaf(first)));
            }
            if let Some((new_first, sibling)) = remove(first, target) {
                return Some((
                    PaneNode::Split {
                        axis: node_axis(node),
                        ratio_basis_points: node_ratio(node),
                        first: Box::new(new_first),
                        second: second.clone(),
                    },
                    sibling,
                ));
            }
            let (new_second, sibling) = remove(second, target)?;
            Some((
                PaneNode::Split {
                    axis: node_axis(node),
                    ratio_basis_points: node_ratio(node),
                    first: first.clone(),
                    second: Box::new(new_second),
                },
                sibling,
            ))
        }
    }
}

fn first_leaf(node: &PaneNode) -> u64 {
    match node {
        PaneNode::Leaf(id) => *id,
        PaneNode::Split { first, .. } => first_leaf(first),
    }
}

fn node_axis(node: &PaneNode) -> SplitAxis {
    match node {
        PaneNode::Split { axis, .. } => *axis,
        PaneNode::Leaf(_) => unreachable!(),
    }
}
fn node_ratio(node: &PaneNode) -> u16 {
    match node {
        PaneNode::Split {
            ratio_basis_points, ..
        } => *ratio_basis_points,
        PaneNode::Leaf(_) => unreachable!(),
    }
}

fn collect_leaves(node: &PaneNode, output: &mut Vec<u64>) {
    match node {
        PaneNode::Leaf(id) => output.push(*id),
        PaneNode::Split { first, second, .. } => {
            collect_leaves(first, output);
            collect_leaves(second, output);
        }
    }
}

fn layout_node(node: &PaneNode, bounds: PaneBounds, output: &mut Vec<(u64, PaneBounds)>) {
    match node {
        PaneNode::Leaf(id) => output.push((*id, bounds)),
        PaneNode::Split {
            axis,
            ratio_basis_points,
            first,
            second,
        } => {
            let ratio = (*ratio_basis_points).clamp(1, 9_999);
            let (first_bounds, second_bounds) = match axis {
                SplitAxis::Horizontal => {
                    let first_width = bounds.width as u32 * ratio as u32 / 10_000;
                    let first_width = first_width as u16;
                    (
                        PaneBounds {
                            width: first_width,
                            ..bounds
                        },
                        PaneBounds {
                            x: bounds.x + first_width,
                            width: bounds.width - first_width,
                            ..bounds
                        },
                    )
                }
                SplitAxis::Vertical => {
                    let first_height = bounds.height as u32 * ratio as u32 / 10_000;
                    let first_height = first_height as u16;
                    (
                        PaneBounds {
                            height: first_height,
                            ..bounds
                        },
                        PaneBounds {
                            y: bounds.y + first_height,
                            height: bounds.height - first_height,
                            ..bounds
                        },
                    )
                }
            };
            layout_node(first, first_bounds, output);
            layout_node(second, second_bounds, output);
        }
    }
}

fn split_bounds(
    node: &PaneNode,
    bounds: PaneBounds,
) -> Option<(SplitAxis, PaneBounds, PaneBounds, u16)> {
    let PaneNode::Split {
        axis,
        ratio_basis_points,
        ..
    } = node
    else {
        return None;
    };
    let ratio = (*ratio_basis_points).clamp(1, 9_999);
    let (first_bounds, second_bounds) = match axis {
        SplitAxis::Horizontal => {
            let first_width = (bounds.width as u32 * ratio as u32 / 10_000) as u16;
            (
                PaneBounds {
                    width: first_width,
                    ..bounds
                },
                PaneBounds {
                    x: bounds.x + first_width,
                    width: bounds.width - first_width,
                    ..bounds
                },
            )
        }
        SplitAxis::Vertical => {
            let first_height = (bounds.height as u32 * ratio as u32 / 10_000) as u16;
            (
                PaneBounds {
                    height: first_height,
                    ..bounds
                },
                PaneBounds {
                    y: bounds.y + first_height,
                    height: bounds.height - first_height,
                    ..bounds
                },
            )
        }
    };
    Some((*axis, first_bounds, second_bounds, *ratio_basis_points))
}

fn divider_at_node(
    node: &PaneNode,
    bounds: PaneBounds,
    x: u16,
    y: u16,
    tolerance: u16,
) -> Option<DividerAxis> {
    let (axis, first, second, _) = split_bounds(node, bounds)?;
    let hit = match axis {
        SplitAxis::Horizontal => {
            let divider = second.x;
            x.abs_diff(divider) <= tolerance
                && y >= bounds.y
                && y <= bounds.y.saturating_add(bounds.height)
        }
        SplitAxis::Vertical => {
            let divider = second.y;
            y.abs_diff(divider) <= tolerance
                && x >= bounds.x
                && x <= bounds.x.saturating_add(bounds.width)
        }
    };
    if hit {
        return Some(match axis {
            SplitAxis::Horizontal => DividerAxis::Horizontal,
            SplitAxis::Vertical => DividerAxis::Vertical,
        });
    }
    divider_at_node(node_first(node), first, x, y, tolerance)
        .or_else(|| divider_at_node(node_second(node), second, x, y, tolerance))
}

fn resize_divider_node(
    node: &mut PaneNode,
    bounds: PaneBounds,
    x: u16,
    y: u16,
    delta: i16,
    tolerance: u16,
) -> bool {
    let Some((axis, first, second, _)) = split_bounds(node, bounds) else {
        return false;
    };
    let hit = match axis {
        SplitAxis::Horizontal => x.abs_diff(second.x) <= tolerance,
        SplitAxis::Vertical => y.abs_diff(second.y) <= tolerance,
    } && match axis {
        SplitAxis::Horizontal => y >= bounds.y && y <= bounds.y.saturating_add(bounds.height),
        SplitAxis::Vertical => x >= bounds.x && x <= bounds.x.saturating_add(bounds.width),
    };
    if hit {
        if let PaneNode::Split {
            ratio_basis_points, ..
        } = node
        {
            *ratio_basis_points = (*ratio_basis_points as i16 + delta).clamp(1_000, 9_000) as u16;
            return true;
        }
    }
    resize_divider_node(node_first_mut(node), first, x, y, delta, tolerance)
        || resize_divider_node(node_second_mut(node), second, x, y, delta, tolerance)
}

fn node_first(node: &PaneNode) -> &PaneNode {
    match node {
        PaneNode::Split { first, .. } => first,
        PaneNode::Leaf(_) => unreachable!(),
    }
}

fn node_second(node: &PaneNode) -> &PaneNode {
    match node {
        PaneNode::Split { second, .. } => second,
        PaneNode::Leaf(_) => unreachable!(),
    }
}

fn node_first_mut(node: &mut PaneNode) -> &mut PaneNode {
    match node {
        PaneNode::Split { first, .. } => first,
        PaneNode::Leaf(_) => unreachable!(),
    }
}

fn node_second_mut(node: &mut PaneNode) -> &mut PaneNode {
    match node {
        PaneNode::Split { second, .. } => second,
        PaneNode::Leaf(_) => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_directions_preserve_visual_order_and_axis() {
        let mut tree = PaneTree::new(1);
        let right = tree.split_active(SplitDirection::Right);
        assert_eq!(tree.leaves(), vec![1, right]);
        assert!(matches!(
            tree.root(),
            PaneNode::Split {
                axis: SplitAxis::Horizontal,
                ..
            }
        ));
        tree.set_active(1);
        let up = tree.split_active(SplitDirection::Up);
        assert_eq!(tree.leaves(), vec![up, 1, right]);
    }

    #[test]
    fn closing_collapses_parent_and_activates_sibling() {
        let mut tree = PaneTree::new(1);
        let second = tree.split_active(SplitDirection::Down);
        tree.set_active(1);
        assert_eq!(tree.close_active(), Some(second));
        assert_eq!(tree.leaves(), vec![second]);
        assert_eq!(tree.active(), second);
        assert!(tree.close_active().is_none());
    }

    #[test]
    fn resizing_expands_the_active_pane_and_clamps_the_ratio() {
        let mut tree = PaneTree::new(1);
        let second = tree.split_active(SplitDirection::Right);
        assert!(tree.resize_active(1_000));
        assert_eq!(tree.layout()[0].1.width, 4_000);
        assert_eq!(tree.layout()[1].1.width, 6_000);
        assert!(tree.resize_active(20_000));
        assert_eq!(tree.layout()[0].1.width, 1_000);
        assert_eq!(tree.layout()[1].1.width, 9_000);
        assert!(tree.set_active(second));
        assert!(tree.resize_active(-1_000));
        assert_eq!(tree.layout()[0].1.width, 2_000);
    }

    #[test]
    fn invalid_activation_does_not_change_tree() {
        let mut tree = PaneTree::new(1);
        assert!(!tree.set_active(99));
        assert_eq!(tree.active(), 1);
        assert_eq!(tree.leaves(), vec![1]);
    }

    #[test]
    fn layout_computes_nested_normalized_bounds() {
        let mut tree = PaneTree::new(1);
        let right = tree.split_active(SplitDirection::Right);
        let down = tree.split_active(SplitDirection::Down);
        assert_eq!(
            tree.layout(),
            vec![
                (
                    1,
                    PaneBounds {
                        x: 0,
                        y: 0,
                        width: 5_000,
                        height: 10_000
                    }
                ),
                (
                    right,
                    PaneBounds {
                        x: 5_000,
                        y: 0,
                        width: 5_000,
                        height: 5_000
                    }
                ),
                (
                    down,
                    PaneBounds {
                        x: 5_000,
                        y: 5_000,
                        width: 5_000,
                        height: 5_000
                    }
                ),
            ]
        );
    }

    #[test]
    fn divider_hit_and_resize_choose_the_outermost_nested_split() {
        let mut tree = PaneTree::new(1);
        let right = tree.split_active(SplitDirection::Right);
        let down = tree.split_active(SplitDirection::Down);
        assert_eq!(
            tree.divider_at(5_000, 2_500, 50),
            Some(DividerAxis::Horizontal)
        );
        assert_eq!(
            tree.divider_at(7_500, 5_000, 50),
            Some(DividerAxis::Vertical)
        );
        assert!(tree.resize_divider_at(5_000, 2_500, 1_000, 50));
        assert_eq!(tree.layout()[0].1.width, 6_000);
        assert_eq!(tree.layout()[1].0, right);
        assert_eq!(tree.layout()[2].0, down);
    }

    #[test]
    fn drop_zone_maps_edges_and_moves_a_pane_into_the_target_split() {
        let mut tree = PaneTree::new(1);
        let second = tree.split_active(SplitDirection::Right);
        assert_eq!(DropZone::from_local_position(0.5, 0.5), DropZone::Center);
        assert_eq!(DropZone::from_local_position(0.05, 0.5), DropZone::Left);
        assert_eq!(DropZone::from_local_position(0.5, 0.95), DropZone::Bottom);
        assert!(tree.move_pane(second, 1, DropZone::Bottom));
        assert_eq!(tree.leaves(), vec![1, second]);
        assert_eq!(tree.active(), second);
        assert!(matches!(
            tree.root(),
            PaneNode::Split {
                axis: SplitAxis::Vertical,
                ..
            }
        ));
    }
}
