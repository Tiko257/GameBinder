# GameBinder V110.2 — Temporary App ID Card Preview

Based on the validated V109/V110.1 behavior.

## Changes
- Create by App ID now accepts either a numeric Steam App ID or a Steam game URL.
- Generated cards are **temporary** and are never inserted into the synced library.
- A dedicated temporary viewport opens with the generated card.
- The card can be clicked to flip between front and back.
- The temporary viewport includes **Print this card**, which prints only that card using the existing duplex PDF/print engine.
- Closing the temporary viewport destroys the temporary card from the visible UI and clears its temporary detail cache when it is not part of the library.
- Existing library synchronization, exclusions, card design, artwork behavior, and normal multi-card PDF printing are preserved.
