# NHL Scores Live

A static web app that shows today's NHL games with:

- **Live scores** and a **running game clock** with the period (e.g. `12:34 · 2nd`). The clock counts down every second in your browser and resyncs to the official clock on each refresh. It refreshes every 15s while games are live and every 60s otherwise.
- **Pregame moneyline** for each team and the **over/under** total. Once a game starts, the app keeps showing the closing *pregame* line, not live odds.
- Upcoming start times in your local time, final scores, TV networks, and arrows to move between days.

Data comes from ESPN's public NHL scoreboard feed (`site.api.espn.com`). No API key or build step needed.

## Run it

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

It also works on GitHub Pages: Settings → Pages → deploy from this branch.

## Notes

- Hockey clocks stop on every whistle, so the local countdown may get a few seconds ahead between refreshes. It snaps back on the next refresh.
- Pregame lines seen before puck drop are saved in `localStorage`, so they stick around even if the feed drops them during the game.
