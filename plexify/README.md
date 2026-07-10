# Plexify

Plexify adds a **Plexify** button near the bottom of Ampwin's active skin. It
opens a theme-aware Plex browser inside Ampwin with:

- Plex sign-in through the official Plex authorization page.
- Plex Media Server discovery and server switching.
- Home hubs such as Continue Watching and Recently Added.
- Collapsible library navigation for movies, TV, music, and other libraries.
- Back navigation and search.
- Double-click playback through Ampwin's active player.
- Right-click actions for Play now, the current Ampwin playlist, and saved
  Ampwin playlists.

## Requirements

Plexify requires an Ampwin build whose public addon API includes:

```js
ampwin.network.request(options)
```

The request must run in Electron's main process and support HTTP(S), headers,
request bodies, timeouts, and text responses.

## Controls

- Click **Plexify** to open or close the browser.
- Use the top-left menu button to collapse the sidebar.
- Use **Back** to return through Plexify navigation.
- Click a show, season, artist, or album to open it.
- Double-click a movie, episode, or track to add it to Ampwin and play it.
- Right-click playable media to add it to the current or a saved playlist.

## Authentication and stored data

Plexify stores its client identifier, device signing key, and Plex user token in
the addon's local storage. **Sign out** clears the Plex token and selected server
state. Plex Media Server access tokens are obtained from Plex resource discovery.

## Playback notes

Plexify uses the selected media item's Plex `Part` URL with its server access
token. Ampwin treats it as a remote track and routes it through its normal
audio/video playback path. The Plex server must permit access to the media part.

Saved playlist entries contain the authenticated Plex media URL available when
the entry was created. If Plex later invalidates that server token, sign in again
and re-add the item.

