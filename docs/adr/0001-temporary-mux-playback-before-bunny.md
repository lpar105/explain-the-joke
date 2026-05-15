# Temporary Mux playback before Bunny

Sets use a temporary Mux-backed playback source first so newly uploaded media becomes playable quickly, then switch to a Bunny-backed playback source once Bunny encoding is ready because responsiveness is a core product feature and Bunny is the lower-cost long-term host. The product keeps one stable set playback experience while the active playback source changes behind the scenes, and the temporary Mux asset should be deleted as soon as the Bunny source is ready and active to limit expensive storage.
