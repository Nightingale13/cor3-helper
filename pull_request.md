## Summary

This adds automatic drone expeditions and updates mercenary automation to work with the game's new mail system.

## Changes

- **Drone Expeditions:** The helper can choose a drone mission, send it out, collect its rewards and repair it between trips. It can also use the time spent charging to squeeze in extra repairs. Drone choices use the existing Decisions settings, and you can follow its trips in Active and Archived Expeditions.
- **Mercenary rewards:** Rewards are paid and collected from mail before the next trip. If credits run low, auto-send waits and tries again when more are available.
- **Auto-sell:** The auto-sell option can make room for both drone and mercenary rewards when the stash is full.
- **Job access:** Job automation checks that it can reach the job server and market before taking a job, and checks the market again before handing it in.
- **Loadout selection:** Hardware and software selection is improved for hacking, decrypting and finding valuable files.
- **Automation fixes:** Temporary connection issues recover automatically, with more reliable Auto Jobs startup and restarts.
- **Manual controls:** Automation leaves your windows alone, and manual hardware and software swaps respond faster.
- **Insurance:** A new toggle lets you insure high-risk mercenary expeditions.
- **Drone defaults:** For new drone setups, auto-send, lowest-battery mission selection and both repair options start on. Repairs start at 20% durability and aim for 60%, with extra repairs allowed during charging. Saved settings are kept. Drone upgrades are still managed in game.

## Testing

- [x] All 186 automated tests pass.
- [x] Extension builds successfully with `npm run build`.
- [ ] Loaded extension in Chrome and tested on cor3.gg.
- [ ] Verified no console errors on `chrome://extensions` and DevTools console logs.
- [ ] Tested with automation features enabled.
- [ ] Tested each existing feature to check that it still works as expected.

## Checklist

- [x] Code follows the existing style and uses the existing JavaScript build setup.
- [x] No unnecessary comments added.
- [ ] Checked README.md for necessary changes and applied them.
- [x] Updated manifest.json version to 1.8.0.
