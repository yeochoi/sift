# Sift

Five picks a week, chosen for where you are going. Sift reads trusted design and AI sources, and every week picks five reads for your role, your goal and your topics. When you finish the five, you are done for the week.

## Principles

1. **A week has an end.** Five picks, a count of how many are read, and a line that says that is all. Never an endless feed.
2. **Say why.** Every pick carries one line on why it was chosen for you. Trust in the curation comes from seeing the reason.
3. **Blue means state and action.** Ink blue is for the main button, a selected option, a selected chip, the current tab and the read check. Never to rank content.
4. **Equal tags.** Try it and Know it share one neutral style and differ only by icon, so neither reads as more important.
5. **Read here, not there.** The week in short and each full summary are written so the article is optional. The original is one tap away, by the source name and at the end.
6. **One soft block per screen.** `tint` sits only behind what is enough on its own, the week in short or a pick's one line gist.
7. **Same family as SaySay and Manna.** The in the middle direction, one warm ground, Outfit, light titles, content on the page without cards.

## Content

- Plain words, sentence case, short. No colons, semicolons or dashes in UI text. A middle dot joins the slot and the source in a meta line.
- English only.
- Summaries and why lines come from the article text only. Never invent facts.

## Color

| Role | Tokens | Use |
| --- | --- | --- |
| Action and state | `primary`, `blue-text`, `soft` | Main button, selected option, selected chip, current tab, read check, Why you |
| Ground | `bg`, `surface`, `line`, `border` | Screens, secondary buttons, fields, hairlines |
| Text | `ink`, `muted`, `tag-text` | Content, meta lines, tags |
| Quiet | `chip`, `ring`, `tint` | Tags, round buttons, segmented track, empty option circle |
| Danger | `danger` | Reset only |

Rules
- `primary` is a fill or a graphic. Blue text always uses `blue-text`.
- A read pick turns its title `muted` and swaps its chevron for the `primary` check.

## Typography

Outfit from Google Fonts. Only 300, 400 and 500.

| Style | Size | Weight | For |
| --- | --- | --- | --- |
| `hero` | 34 | Light | First open headline |
| `title` | 28 | Light | Screen titles, an opened pick |
| `pick` | 17 | Regular | Pick titles, option names |
| `body` | 17, line 25 | Regular | Why you, In short |
| `button` | 17 | Medium | Full width buttons |
| `lead` | 15 | Regular | Line under a title, chips |
| `small` | 13 | Regular | Meta lines, labels |
| `tag` | 12 | Regular | Try it and Know it |
| `tab` | 11 | Regular | Tab labels |

## Layout

- 28 side margin, 64 to the title. On wide screens content centers in a 560 column.
- Picks are rows on the page split by `line` hairlines. No cards.
- An option row is 64 tall with the option name on the left and a 24 circle on the right. Selected is a `primary` disc with a white check.
- Topic chips are 40 tall. Selected chips use `soft` with `blue-text` and a check. Others are `surface` with `border` and a plus.
- One main button per screen, full width, 52 tall, at the bottom. Secondary buttons are `surface` with a `border`.
- The tab bar sits flat on the ground with three tabs, This week, Past weeks and Settings.

## Iconography

- Line icons, round caps and joins, 24 grid, 1.6 to 2 stroke.
- Try it uses a pointer, Know it uses an eye, both 12 in the tag.
- Every chevron is 14 in `muted`.

## Accessibility

- WCAG 2.2 AA. Targets at least 44.
- Focus rings are 2px `primary` with a 2px gap.
- Options are real radio buttons, chips are toggle buttons with aria-pressed.
