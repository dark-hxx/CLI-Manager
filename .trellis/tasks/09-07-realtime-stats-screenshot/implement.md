# Implementation

1. Add capture and clipboard adapter with explicit size/resource limits.
2. Add styled header button and capture/scroll markers.
3. Add narrowly scoped permission and zh-CN/en-US messages.
4. Test full-height dimensions, clone/clipboard cleanup, reentrancy and permission contract; run TypeScript, frontend build and standalone architecture checks. Record manual desktop limitations truthfully.
5. Update TEMP changelog, feature inventory and capture contract.
6. Review correction: enforce a 2x ordinary capture floor (up to 3x device density), retain the existing safety budget, and add unit/browser regression assertions for exported density.
