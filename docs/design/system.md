# Monitoring design contract

Reference: `monitoring-concept.png`, generated with the built-in Image Gen UI mockup tool.

Primary brief: complete Chinese scientific earthquake cataloging desktop screen; restrained navy monitoring console, left navigation, global station/event map, recent event list, bottom event table, footer service state. No invented live performance metrics. Event workspace uses a distance–time waveform canvas and right-hand location inspector.

Tokens: background #0c121b; panel #111c29; borders #243343; teal #4de0bb; amber #f2b366; text #e7eff6; muted #8093a7. Inter/system + Noto Sans SC body, IBM Plex Mono numbers, 5px panel corners, fine rules, restrained line icons.

Components: persistent navigation, header, metric strip, map panel, compact recent rows, shared event table, review inspector, waveform canvas, forms/dialogs, audit list, status badges. At narrower widths the inspector stacks below waveforms and navigation becomes a drawer.

Intentional content changes from the concept: all illustrative values are replaced by actual API values; no metric silently falls back to a demo number. USGS data is labeled external. Unsubscribed/unknown stations remain distinguishable from live samples. All times UTC. The compact footer reports observed process health.
