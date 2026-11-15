# Temporary Mux playback before canonical Bunny media

Sets use a temporary Mux-backed Playback Source first so newly uploaded media becomes playable quickly. After the Trim Range is confirmed, Modal creates a canonical trimmed `playback.mp4` whose timeline starts at zero and uploads it to Bunny Storage. The Set switches directly to that MP4 through its Bunny CDN URL only after the CDN successfully serves a byte-range request for the media; Bunny Stream transcoding is not part of this handoff. The temporary Mux asset is deleted only after the ready Bunny Playback Source is active.
