# Orchestrace UI Component Standards

This document defines concrete UI component standards for the Orchestrace product. It supplements the general UI/UX design guide with actionable, product-specific rules and patterns for key interface elements. All contributors should reference this guide when building or updating UI components.

---

## 1. Top Bar
- **Content:**
  - Product logo (left)
  - Session selector (center, if applicable)
  - User badge with avatar/email (right)
  - Logout button (right, next to user badge)
- **Behavior:**
  - Always visible, fixed at the top
  - Responsive: collapses to hamburger menu on mobile
  - User badge shows current user, with tooltip for full email
  - Logout triggers immediate session end and UI update
- **Style:**
  - Height: 56px desktop, 48px mobile
  - Background: #181C20 (dark), white text/icons
  - Subtle shadow for separation

## 2. Sessions Rail
- **Content:**
  - List of active sessions (vertical, left side)
  - Each session: icon, name, status indicator
  - New session button at top or bottom
- **Behavior:**
  - Click to switch session (highlights active)
  - Hover: show full session name/metadata
  - Drag-and-drop to reorder (if supported)
- **Style:**
  - Width: 72px collapsed, 240px expanded
  - Background: #23272E
  - Active session: accent border, bold text

## 3. Graph Canvas
- **Content:**
  - Node-based workflow graph
  - Nodes: icon, label, status, quick actions
  - Edges: directional, labeled if needed
- **Behavior:**
  - Pan/zoom with mouse/touch
  - Click node: open details panel
  - Drag to reposition nodes
  - Context menu on right-click
- **Style:**
  - Light grid background
  - Nodes: rounded, subtle shadow, color by type/status
  - Edges: smooth curves, hover highlight

## 4. Logs Panel
- **Content:**
  - Real-time log stream for current session/task
  - Search/filter input
  - Severity color-coding (info, warn, error)
- **Behavior:**
  - Auto-scroll to latest, unless user scrolls up
  - Copy-to-clipboard for log lines
  - Expand/collapse stack traces
- **Style:**
  - Monospace font
  - Background: #101214
  - Error: #FF4D4F, Warn: #FFC53D, Info: #36CFC9

## 5. Settings Forms
- **Content:**
  - Labeled input fields, grouped by section
  - Save/cancel buttons (sticky footer)
  - Inline validation and help text
- **Behavior:**
  - Real-time validation feedback
  - Disabled state for incomplete/invalid forms
  - Keyboard accessible (tab order, focus ring)
- **Style:**
  - Field labels: left-aligned, 14px
  - Inputs: 40px height, 8px radius
  - Error: red border, help text below

---

## General Component Rules
- **Accessibility:** All components must be keyboard navigable and screen-reader friendly.
- **Responsiveness:** Layouts adapt to mobile, tablet, and desktop breakpoints.
- **Consistency:** Use shared design tokens for color, spacing, and typography.
- **State Feedback:** Loading, error, and success states must be visually distinct.
- **Testing:** Each component should have unit and integration tests for core behaviors.

---

## References
- See [UI-UX-DESIGN-GUIDE.md](./UI-UX-DESIGN-GUIDE.md) for foundational principles.
- Update this document as new components or patterns are introduced.
