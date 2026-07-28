# ChatGPT desktop text shimmer

Research date: 2026-07-27

## Result

The installed OpenAI desktop package ships a continuous text shimmer named
`loading-shimmer`. The visible highlight moves left to right by animating
`background-position` from `-100% 0` to `250% 0`. It takes 2 seconds, uses
`steps(48, end)`, repeats infinitely, and has no inter-cycle delay. The moving
band is a 50%-wide, non-repeating background clipped to the text, with a flat
highlight plateau between 40% and 60%.

This is the implementation to copy for the continuous ChatGPT-style text
shimmer:

```css
.loading-shimmer-pure-text,
.loading-shimmer {
  --text-primary: var(--color-token-description-foreground);
  --shimmer-text-secondary: color-mix(in srgb, var(--text-primary) 55%, transparent);
  --shimmer-contrast: #ffffffbf;

  background: var(--shimmer-text-secondary)
    linear-gradient(
      to right,
      transparent 0%,
      var(--shimmer-contrast) 40%,
      var(--shimmer-contrast) 60%,
      transparent 100%
    );
  -webkit-text-fill-color: transparent;
  background-position: -100% 0;
  background-repeat: no-repeat;
  background-size: 50% 200%;
  -webkit-background-clip: text;
  background-clip: text;
  animation: loading-shimmer 2s steps(48, end) 0s infinite;
  display: inline-block;
}

.dark .loading-shimmer-pure-text,
.dark .loading-shimmer {
  --shimmer-text-secondary: color-mix(in srgb, var(--text-primary) 45%, transparent);
  --shimmer-contrast: #0009;
}

@keyframes loading-shimmer {
  0% {
    background-position: -100% 0;
  }

  100% {
    background-position: 250% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .loading-shimmer-pure-text,
  .loading-shimmer {
    animation: none;
  }
}
```

The production bundle also contains fallbacks omitted above for clarity:

- without `color-mix`, `--shimmer-text-secondary` falls back to
  `var(--text-primary)`;
- a legacy `-webkit-gradient(linear, 100% 0, 0 0, ...)` declaration follows the
  modern gradient;
- `text-fill-color: transparent` accompanies
  `-webkit-text-fill-color: transparent`;
- `.loading-shimmer:hover` restores the primary text color and stops the
  animation, while `.loading-shimmer-pure-text` does not have that hover rule.

## Primary evidence

The installed package is:

- package identity: `OpenAI.Codex`
- package version: `26.721.3404.0`
- manifest display name and description: `ChatGPT`
- executable: `app/ChatGPT.exe`
- install root:
  `C:\Program Files\WindowsApps\OpenAI.Codex_26.721.3404.0_x64__2p2nqsd0c76g0`

The package identity, display name, and executable come directly from
`AppxManifest.xml` at lines 3, 5, 34, and 35.

The application bundle is:

`C:\Program Files\WindowsApps\OpenAI.Codex_26.721.3404.0_x64__2p2nqsd0c76g0\app\resources\app.asar`

SHA-256:
`68C2A5E9FBF171A9EA31BF802113803CA0DCDD8561869224AF9C73901C47114A`

Within that ASAR:

- `webview/assets/app-BSNLQ2Yt.css`
  - defines `.loading-shimmer-pure-text`, `.loading-shimmer`, the light/dark
    variables, reduced-motion behavior, and `@keyframes loading-shimmer`;
  - SHA-256:
    `A972F88AF8E2A0A6E1326523113BB23B073DC935EB8441EA3E6FE0291757E157`.
- `webview/assets/app-initial-_qVLmrD6.js`
  - the component whose default localized message is `Thinking` applies
    `loading-shimmer-pure-text`;
  - the source description is
    `Default placeholder shown while the assistant is thinking`;
  - SHA-256:
    `C7EA17872154A744B1EFE87B19C01461742AE08D88F5EA780D0E78F7913E9755`.
- `webview/assets/local-conversation-thread-D7g-LH1z.js`
  - applies `loading-shimmer-pure-text` to active status labels and other
    in-progress text, showing that the same primitive is reused beyond the
    central `Thinking` placeholder.

The exact minified production declaration is:

```css
.loading-shimmer-pure-text,
.loading-shimmer {
  background: var(--shimmer-text-secondary)
    linear-gradient(
      to right,
      transparent 0%,
      var(--shimmer-contrast) 40%,
      var(--shimmer-contrast) 60%,
      transparent 100%
    );
  background: var(--shimmer-text-secondary) -webkit-gradient(
      linear,
      100% 0,
      0 0,
      from(transparent),
      color-stop(0.4, var(--shimmer-contrast)),
      color-stop(0.6, var(--shimmer-contrast)),
      to(transparent)
    );
  text-fill-color: transparent;
  -webkit-text-fill-color: transparent;
  background-position: -100% 0;
  background-repeat: no-repeat;
  background-size: 50% 200%;
  -webkit-background-clip: text;
  background-clip: text;
  animation-name: loading-shimmer;
  animation-duration: 2s;
  animation-timing-function: steps(48, end);
  animation-iteration-count: infinite;
  animation-delay: 0s;
  display: inline-block;
}
@keyframes loading-shimmer {
  0% {
    background-position: -100% 0;
  }
  to {
    background-position: 250% 0;
  }
}
```

## Experiment-gated alternative

The bundle also ships a `cadenced_legacy` experiment for the `Thinking`
component. When assigned, it replaces the continuous animation with a
duplicated-text masked sweep:

- 1-second sweep;
- `steps(48, end)`;
- one iteration;
- first sweep after 600 ms;
- repeated every 4 seconds;
- active class removed after 1 second;
- mask:
  `linear-gradient(90deg, #0000 0%, #000 20% 30%, #0000 50% 100%)`;
- outer sweep transform: `translate(-50%)` to `translate(125%)`;
- inner highlight transform: `translate(50%)` to `translate(-125%)`.

Evidence:

- `webview/assets/app-initial-_qVLmrD6.js` contains the feature gate
  `1585730870`, variant/group `cadenced_legacy`, and the 600/1000/4000 ms
  scheduling constants.
- `webview/assets/app-initial-Cla-mNzi.css` contains the cadenced classes and
  keyframes; SHA-256:
  `B235FBF4139B1BA2E5059ABACEE322C2C89110743EE0101B481BC4DD7D60363C`.

This alternative is deliberately not seamless or constant. For a request that
specifically calls for a constant seamless loop, the default
`loading-shimmer-pure-text` path above is the matching shipped implementation.

## Confidence and limitations

Confidence is high for the shipped CSS, direction, duration, easing, keyframes,
gradient stops, color variables, and component wiring because all were read
directly from the installed signed package.

The running renderer had no remote-debugging endpoint, and no plain-text
feature assignment for gate `1585730870` was present in the Chromium profile.
Therefore the local account's current server-side assignment to
`cadenced_legacy` could not be proven from cached state. This does not affect
the exact continuous implementation or the fact that it is the component's
non-experiment path.
