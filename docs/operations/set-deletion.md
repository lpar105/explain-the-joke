# Set deletion operations

Set deletion removes the Set from product access in the same Convex transaction
that creates a temporary cleanup job. The cleanup job cancels active Convex and
Modal work, removes Mux media, deletes the Set's Bunny Storage prefix, purges the
matching CDN paths, deletes the remaining Convex graph in bounded batches, and
then deletes itself.

Cleanup retries with exponential backoff and logs every failed attempt. A
remaining `setDeletionJobs` document therefore means operator attention may be
required; there is intentionally no completed-deletion record.

In addition to the existing Mux and Bunny Storage variables, Convex must have
`BUNNY_CDN_API_KEY` set to the bunny.net account API key authorized to purge CDN
URLs. The existing `BUNNY_API_KEY` remains the Storage Zone password and should
not be reused for this purpose.
