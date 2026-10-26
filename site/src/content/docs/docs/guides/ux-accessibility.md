---
title: "UX and accessibility"
description: "The interface principles Koinonia commits to (low cognitive load, reduced motion, AA contrast, keyboard first) and how this site applies them."
---

These principles come from the project plan and apply to the studio and to this site.

## Principles

1. **Two views**, Foco and Painel, switchable with a shortcut, state preserved. See [the views](../../concepts/views/).
2. **Progressive disclosure and low cognitive load**: one primary action per screen.
3. **Persistent state, undo for everything, no lost progress.**
4. **Gentle, optional reminders**: visual timers, breaks, checklists.
5. **Minimal, optional motion.** Nothing flashes. `prefers-reduced-motion` is respected.
6. **Contrast AA or better**, readable type, adjustable density and colors, **keyboard first**.
7. **Grouped, mutable notifications.** Never interrupt the live without need.

## How this site implements them

| Principle | Implementation |
| --- | --- |
| Two views | Header control and `Alt+Shift+V` toggle Foco and Painel; preference persisted locally. |
| Adjustable density | Compact, Comfortable, Spacious. |
| Motion | Follows the OS setting by default; a Motion control can turn it off. No animation flashes; the longest is under a second. |
| Contrast | Text and controls target WCAG 2.2 AA in light and dark themes. Focus rings are always visible. |
| Keyboard | Every control is reachable and operable; skip link on the landing; the shortcut uses a modifier combination so it does not collide with typing. |
| Themes | Dark and light, following the system by default. |
| Structure | Semantic landmarks, one `h1` per page, diagrams have text equivalents. |
| Agents | Markdown twins, `llms.txt`, and WebMCP tools. See [docs for agents](../agents/). |

## Studio checklist (for contributors)

- Does every screen have one obvious primary action?
- Can I undo it? Does the state survive a reload?
- Does it work with keyboard only and with motion reduced?
- Does contrast hold at AA in both themes, and at 200% zoom?
- Are notifications groupable and mutable?

:::note
Preferences on this site are stored only in your browser (`localStorage`) and are never sent anywhere.
:::
