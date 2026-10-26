---
title: "Foco and Painel views"
description: "Koinonia's two interface views, Foco (one thing at a time, calm) and Painel (everything visible, dense), switchable at any time without losing state. This site implements both."
---

:::note[Status]
The studio UI already has Foco and Painel (`studio/src/ui/`), and the design system is still taking shape (phase 8). **This documentation site implements both views too**, so you can try the idea here.
:::

Koinonia has two views from the first screen, switchable at any moment with a shortcut and **without losing state**.

| | **Foco** (focus) | **Painel** (panel) |
| --- | --- | --- |
| Shows | One thing at a time, large and calm | Everything at once, dense |
| Next step | Obvious, a single primary action | You choose |
| For | Setting up, going live for the first time, low-pressure moments | Operators who know the tool and need the whole picture |
| Motion | Minimal | Minimal and optional |

## Shared rules

- **Progressive disclosure.** Advanced controls appear when asked for.
- **Low cognitive load.** One primary action per screen.
- **Persistent state and undo everywhere.** Switching views never discards progress.
- **Gentle, optional reminders:** visual timers, breaks, checklists.
- **Grouped, mutable notifications.** The live is never interrupted unless it must be.

## Try it on this site

Use the **View** control in the header (or `Alt+Shift+V`):

- **Painel** is the default: navigation, table of contents and full width.
- **Foco** hides side panels, enlarges text and narrows the measure for continuous reading, and turns decorative motion off.
- **Density** and **Motion** are adjustable independently. Choices are remembered in your browser only.

See [UX and accessibility](../../guides/ux-accessibility/).
