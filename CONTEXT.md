# Tight Five

Tight Five is a performance review product for standup comedians. It organizes uploaded recordings, their analysis, and the editorial structures used to review and improve a comedy set.

## Language

**Set**:
One retained audio or video performance recording in a user's library with a stable identity.
_Avoid_: Upload, file, clip, recording

**Breakdown**:
The current editable analysis artifact for a set.
_Avoid_: Revision, pass, version, report

**Line**:
A readable timed unit in the breakdown transcript that the comic can review, click, and edit in sync with playback.
_Avoid_: Sentence, utterance

**Laugh Region**:
A timed audience-laughter event owned by the line during which the laugh begins.
_Avoid_: Reaction, laugh marker, applause block

**Share Link**:
An access grant that exposes a read-only review surface for a set and its current breakdown, either to any signed-in user with the link or to specific usernames.
_Avoid_: Public page, export

**Comment Thread**:
A timestamped discussion attached to a set or a point within its breakdown, with shared visibility by default and optional private visibility.
_Avoid_: Note, annotation

**Chapter**:
A user-managed labeled time range inside a breakdown that organizes part of a set.
_Avoid_: Segment, clip, transcript block

**Bit**:
A reusable piece of material that can appear in multiple sets.
_Avoid_: Chapter, joke run

**Playback Source**:
A streamable media source for a set, with one source active for playback at a time.
_Avoid_: Mux asset, Bunny asset, player variant

**Trim Range**:
The user-selected start and end boundaries applied during upload to define the retained media for a set.
_Avoid_: Crop, cut list, local zero

**Set Status**:
The current availability state of a set in the library and review flow.
_Avoid_: Job status, pipeline state

**Metadata Field**:
A user-defined labeled value attached to a set or chapter, with performance date as the only built-in default field at the set level.
_Avoid_: Schema field, system property

**Trash Window**:
The three-day retention period after a user intentionally deletes a set and before it is permanently removed.
_Avoid_: Soft delete, archive period

**Shared Review**:
A set another user can access through a share link and revisit later from their own account.
_Avoid_: Imported set, shared library item

**Username**:
A unique user-facing handle used to find an account for targeted sharing.
_Avoid_: Account ID, login key

**Plan**:
The feature-access level attached to a user account.
_Avoid_: Role, persona, account type

**Lifetime Upload Quota**:
The total amount of set duration a free user can ever upload across the life of the account.
_Avoid_: Storage cap, active library cap

**Resubscribe Window**:
The seven-day period after a paid user stops paying, during which their sets are locked while they can still resubscribe.
_Avoid_: Trial grace window, billing retry

## Relationships

- A **Set** belongs to exactly one user library
- A **Set** belongs to exactly one user account
- A **Set** has exactly one current **Breakdown**
- A **Set** can have one or more **Playback Sources**
- A **Set** can have zero or more **Share Links**
- A **Share Link** reveals one **Set** and its current **Breakdown**
- A **Comment Thread** belongs to one **Set**
- A **Comment Thread** is anchored to a time range within one **Set**
- A **Breakdown** can have zero or more **Lines**
- A **Breakdown** can have zero or more **Laugh Regions**
- A **Breakdown** can have zero or more **Chapters**
- A **Chapter** belongs to one **Set**
- A **Chapter** can optionally be linked to one **Bit**
- A **Bit** can be linked to zero or more **Chapters**
- A **Bit** belongs to the comedian who owns the linked sets
- A **Bit** is created from at least one performed **Chapter**, not as a standalone empty concept
- A **Set** has at most one active **Playback Source**
- A **Set** has exactly one current **Set Status**
- A **Laugh Region** belongs to exactly one **Line**
- **Lines** form one continuous active track across the playable timeline of a **Set**
- A **Set** can be defined by one upload-time **Trim Range**
- The retained media for a **Set** is the trimmed media chosen during upload
- A **Set** can have zero or more **Metadata Fields**
- A **Chapter** can have zero or more **Metadata Fields**
- **Metadata Field** definitions are reusable across the owning user account
- A **Shared Review** reveals one **Set** to a non-owning user
- A targeted **Share Link** can create a **Shared Review** for a specific account without requiring the original URL later
- A **Username** resolves to one user account, but sharing grants belong to the underlying account identity
- A user account has exactly one current **Plan**
- A free-plan user has a 30-minute **Lifetime Upload Quota**
- A user-intentionally deleted **Set** remains recoverable during its **Trash Window**
- When a paid user stops paying, their owned **Set** library is locked during the **Resubscribe Window**
- If a paid user does not resubscribe during the **Resubscribe Window**, their owned **Set** library is permanently removed at the end of that window
- A free user who has exhausted their **Lifetime Upload Quota** keeps access to existing owned sets but cannot upload additional set duration
- Ownership of a **Set** does not transfer between user accounts in v1

## Example dialogue

> **Dev:** "If a comic uploads one 12-minute club performance, is that one **Set** or several?"
> **Domain expert:** "That is one **Set**; internal segments belong inside it as structure, not as separate library items."
>
> **Dev:** "When the comic retimes laughs and fixes transcript lines, do we create a new **Breakdown** each time?"
> **Domain expert:** "No; in v1 they keep improving the current **Breakdown** rather than managing analysis versions."
>
> **Dev:** "What does a **Share Link** expose?"
> **Domain expert:** "The recipient can review the player, transcript, laugh timeline, chapters, and headline metrics, and they can participate in **Comment Threads** without editing the **Breakdown** itself."
>
> **Dev:** "Do private writing notes and shared feedback use different concepts?"
> **Domain expert:** "No; everything starts as a **Comment Thread**, and the comic can mark a thread private when it should not be shared."
>
> **Dev:** "Are **Chapters** inferred from the transcript?"
> **Domain expert:** "No; a **Chapter** is editorial structure the comic creates to organize a **Set**, even when the transcript would not suggest those boundaries."
>
> **Dev:** "If the same material appears across five open mics, are those all the same **Chapter**?"
> **Domain expert:** "No; each performance has its own **Chapter**, and those chapters can later be linked to one shared **Bit**."
>
> **Dev:** "Does the comic need to know which vendor is serving playback right now?"
> **Domain expert:** "No; the **Set** stays stable in the product while its active **Playback Source** can change behind the scenes."
>
> **Dev:** "Can a **Set** be audio-only?"
> **Domain expert:** "Yes; a **Set** is a performance recording, so audio-only and video recordings both use the same review model."
>
> **Dev:** "Can the comic rerun analysis on a **Set** after upload?"
> **Domain expert:** "No; reprocessing is not a user-facing workflow in the product, and the comic works against the current **Breakdown**."
>
> **Dev:** "Can anyone with a **Share Link** view and comment anonymously?"
> **Domain expert:** "No; recipients must create a free account to access a **Share Link**, even though they do not need a paid subscription."
>
> **Dev:** "When is a **Set** ready?"
> **Domain expert:** "Media playback can become available before the **Breakdown** is finished, so the **Set Status** must distinguish playable media from analysis-ready review."
>
> **Dev:** "If playback is ready but the **Breakdown** is still processing, can the comic open the set page?"
> **Domain expert:** "Yes; the review surface opens progressively, with playback available immediately and analysis surfaces filling in as the **Breakdown** arrives."
>
> **Dev:** "Is the transcript made of **Sentences**?"
> **Domain expert:** "No; the review unit is a **Line**, because standup delivery is not clean grammatical sentence writing."
>
> **Dev:** "If one laugh starts during one line and continues into the next, which line owns it?"
> **Domain expert:** "The **Laugh Region** belongs to the line where it begins, even if the audio of that laugh continues while later playback time passes."
>
> **Dev:** "Can the comic fully reshape a **Laugh Region** in the editor?"
> **Domain expert:** "Yes; the comic can create, retime, split, merge, re-score, and delete **Laugh Regions** as part of the current **Breakdown**."
>
> **Dev:** "Can the comic restructure transcript timing, or only fix the words?"
> **Domain expert:** "The comic can also split, merge, insert, delete, and retime **Lines**, because line boundaries are part of the editable review model."
>
> **Dev:** "What does a **Comment Thread** attach to if lines and chapters are edited later?"
> **Domain expert:** "A **Comment Thread** stays anchored to time first, and the interface can resolve nearby lines or chapters from that anchor."
>
> **Dev:** "Which metadata is built in?"
> **Domain expert:** "Only performance date is built in by default; other **Metadata Fields** are user-defined at the set or chapter level, with suggestions like venue name shown as examples rather than enforced schema."
>
> **Dev:** "Who owns a **Bit**?"
> **Domain expert:** "A **Bit** belongs to the comedian who owns the set; collaborators can discuss material but do not own the comic's reusable catalog."
>
> **Dev:** "Is deleting a **Set** immediate and permanent?"
> **Domain expert:** "No; a deleted **Set** enters a three-day **Trash Window** before permanent removal."
>
> **Dev:** "After a reviewer signs in through a **Share Link**, can they only return with the original URL?"
> **Domain expert:** "No; that access should persist as a **Shared Review** the reviewer can revisit from their own account."
>
> **Dev:** "Can a reviewer download the original media from a **Shared Review**?"
> **Domain expert:** "No; shared access allows playback and discussion, but downloading the original uploaded media remains owner-only."
>
> **Dev:** "Can a **Set** have more than one **Share Link**?"
> **Domain expert:** "Yes; each **Share Link** is an independent access grant that can be revoked without affecting the others."
>
> **Dev:** "Do different **Share Links** on the same set create separate discussion spaces?"
> **Domain expert:** "No; reviewers from different **Share Links** still participate in the same shared comment space for that set."
>
> **Dev:** "How specific is sharing?"
> **Domain expert:** "A **Share Link** can either allow any signed-in user with the link to access the set or target specific users by username."
>
> **Dev:** "If a **Share Link** targets a specific username, does that person still need the invitation URL forever?"
> **Domain expert:** "No; once granted, the access should surface as a **Shared Review** in that user's account even without reopening the original link."
>
> **Dev:** "Do we need separate comedian and reviewer account types?"
> **Domain expert:** "No; the product uses one account model, and different **Plans** unlock different features."
>
> **Dev:** "What can a free plan own?"
> **Domain expert:** "A free user can upload up to 30 minutes of **Set** media over the life of the account through a 30-minute **Lifetime Upload Quota**."
>
> **Dev:** "What happens to sharing when a user's owned sets are removed?"
> **Domain expert:** "The user can still access and participate in **Shared Reviews** on other people's sets, but any sharing of their own sets ends when those owned sets are removed."
>
> **Dev:** "If a reviewer changes their **Username**, do targeted shares break?"
> **Domain expert:** "No; a **Username** is how users find an account, but the actual sharing grant belongs to the stable underlying account."
>
> **Dev:** "If the comic hides a **Comment Thread** they did not participate in, does that remove it for everyone?"
> **Domain expert:** "No; hiding a **Comment Thread** is a personal view control for the comic, not a global visibility change for other reviewers."
>
> **Dev:** "When the comic marks a **Comment Thread** private, who can still see it?"
> **Domain expert:** "Private means owner-only; once a thread is private, only the comedian who owns the set can still see it."
>
> **Dev:** "Can **Chapters** overlap or nest?"
> **Domain expert:** "No; in v1 a set has one flat chapter track, so each moment belongs to at most one **Chapter**."
>
> **Dev:** "Does every moment in a set need to belong to a **Chapter**?"
> **Domain expert:** "No; **Chapters** are optional editorial structure, so unchaptered gaps remain valid parts of a **Set**."
>
> **Dev:** "Can the same **Bit** appear more than once in a single **Set**?"
> **Domain expert:** "Yes; multiple **Chapters** in the same set can link to the same **Bit** when the comic revisits material."
>
> **Dev:** "Are headline metrics edited directly?"
> **Domain expert:** "No; headline metrics are derived from the current **Breakdown**, but the comic can edit the underlying **Laugh Regions**, including their intensity, so the metrics reflect corrected review data."
>
> **Dev:** "How is laugh intensity represented?"
> **Domain expert:** "A **Laugh Region** stores a decimal intensity value under the hood, but the comic edits it using human-facing grades like A+, A, B, C, or F."
>
> **Dev:** "Can one **Set** contain multiple uploaded source files?"
> **Domain expert:** "No; in v1 a **Set** is built from one contiguous uploaded audio or video file."
>
> **Dev:** "Is transcript content searchable in the library?"
> **Domain expert:** "Yes; transcript content and user-defined metadata are both searchable, but they should be queried through explicit scoped search rather than treated as one undifferentiated search surface."
>
> **Dev:** "Are **Metadata Fields** just freeform text?"
> **Domain expert:** "No; user-defined **Metadata Fields** can be typed, with a small set like text, number, date, boolean, and maybe single select."
>
> **Dev:** "If a reviewer loses access to a **Set**, what happens to the comments they already made?"
> **Domain expert:** "Their existing comments remain on the set with attribution, but they can no longer view or participate once access is revoked."
>
> **Dev:** "Can ownership of a **Set** transfer to another account?"
> **Domain expert:** "No; in v1 the comedian's account remains the permanent owner of the **Set**."
>
> **Dev:** "Can a **Bit** exist before it is linked to any performed material?"
> **Domain expert:** "No; a **Bit** comes into existence from real performed **Chapters**, not as a standalone idea with no set history."
>
> **Dev:** "What happens during silence between spoken moments?"
> **Domain expert:** "The previous **Line** remains active, so the line track stays continuous even when the performer pauses."
>
> **Dev:** "Who can make a **Comment Thread** private?"
> **Domain expert:** "Only the comedian who owns the **Set** can switch a **Comment Thread** between shared and private visibility."
>
> **Dev:** "Who controls whether a **Comment Thread** is resolved?"
> **Domain expert:** "The comedian who owns the **Set** has final control over resolving and reopening **Comment Threads**."
>
> **Dev:** "Are **Metadata Fields** visible in shared review by default?"
> **Domain expert:** "No; set-level and chapter-level **Metadata Fields** are owner-only by default."
>
> **Dev:** "When a **Set** is shared, do reviewers see a snapshot or the current state?"
> **Domain expert:** "A **Shared Review** always reflects the current live **Breakdown**, not a frozen snapshot."
>
> **Dev:** "If a private **Comment Thread** becomes shared again, do old replies stay hidden?"
> **Domain expert:** "No; visibility applies to the whole **Comment Thread**, so switching it back to shared reveals the full thread."
>
> **Dev:** "When the comic removes a **Comment Thread**, is that reversible?"
> **Domain expert:** "No; removing a **Comment Thread** is a hard delete in v1."
>
> **Dev:** "Do **Share Links** expire automatically?"
> **Domain expert:** "No; access continues until the owner revokes it or the underlying **Set** disappears."
>
> **Dev:** "Does deleting a **Set** give back free upload capacity?"
> **Domain expert:** "No; the free plan uses a 30-minute **Lifetime Upload Quota**, so permanently removed sets still count against what that account has uploaded."
>
> **Dev:** "What happens when a paid user downgrades?"
> **Domain expert:** "Downgrading does not put them back under the free upload trial model; instead their sets enter a seven-day **Resubscribe Window** where those sets are locked while they can still resubscribe."
>
> **Dev:** "Can anyone still view those sets during the **Resubscribe Window**?"
> **Domain expert:** "No; during the **Resubscribe Window**, neither the owner nor reviewers can view the sets."
>
> **Dev:** "If the owner resubscribes during the **Resubscribe Window**, what is restored?"
> **Domain expert:** "All prior access returns as it was, including owned set access, shared review access, and existing discussion."
>
> **Dev:** "What happens if the **Resubscribe Window** ends without payment?"
> **Domain expert:** "The owned **Set** library is permanently removed immediately at the end of that window."
>
> **Dev:** "What happens when a free user runs out of **Lifetime Upload Quota**?"
> **Domain expert:** "They keep access to their existing owned sets, but they cannot upload additional set duration."
>
> **Dev:** "Do shared reviewers see the private cross-set history behind a **Bit**?"
> **Domain expert:** "No; shared reviewers only see the **Chapter** labels and structure inside the current set, not the owner's private **Bit** model or cross-set history."
>
> **Dev:** "Can shared reviewers edit the review model directly?"
> **Domain expert:** "No; shared reviewers participate through **Comment Threads** only and do not directly edit the owner's **Breakdown**."
>
> **Dev:** "If the owner renames a **Set**, do shared reviewers keep seeing the old name?"
> **Domain expert:** "No; a **Shared Review** reflects the current live state of the **Set**, including its current title."
>
> **Dev:** "Can the comic trim a **Set** before review begins?"
> **Domain expert:** "Yes; upload includes a video-editor trim step, and the selected **Trim Range** defines the media that continues into the set pipeline."
>
> **Dev:** "Does the raw uploaded file remain part of the product after trimming?"
> **Domain expert:** "No; the trimmed media is what continues to long-term storage for the **Set**, and the original upload disappears when the temporary Mux copy is cleaned up."
>
> **Dev:** "After trimming, does the **Set** keep the raw timeline offsets?"
> **Domain expert:** "No; once the **Trim Range** is applied, the retained **Set** timeline resets so the kept media starts at `00:00` everywhere in the product."
>
> **Dev:** "Can the comic change the **Trim Range** later?"
> **Domain expert:** "No; trimming is a one-time upload decision in v1."
>
> **Dev:** "When does the main set pipeline begin?"
> **Domain expert:** "The expensive long-term processing begins only after the comic confirms the upload-time **Trim Range**."
>
> **Dev:** "Does scoped search work only in the library?"
> **Domain expert:** "No; the same scoped search model is used both across the library and inside an individual set's current **Breakdown**."
>
> **Dev:** "Are **Usernames** case-sensitive for targeted sharing?"
> **Domain expert:** "No; **Username** lookup is case-insensitive, even if the product preserves display styling."
>
> **Dev:** "What happens if a **Share Link** is narrowed from broad access to specific usernames only?"
> **Domain expert:** "Users who are no longer allowed lose access immediately, but their past comments remain attributed in the discussion history."
>
> **Dev:** "What happens if a **Share Link** is widened from specific usernames to anyone with the link?"
> **Domain expert:** "Existing invited users keep their durable **Shared Review** access, and anyone else with the link can then gain access too."
>
> **Dev:** "Do **Chapter** labels need to be unique within a set?"
> **Domain expert:** "No; duplicate **Chapter** labels are allowed within a **Set**."
>
> **Dev:** "Do repeated identical **Line** texts need special handling?"
> **Domain expert:** "No; identical **Line** text can appear multiple times because lines are distinguished by their timing, not by unique phrasing."
>
> **Dev:** "Do applause or cheers count as **Laugh Regions**?"
> **Domain expert:** "No; in v1 the reaction model is strictly laughter only."
>
> **Dev:** "Are **Metadata Fields** recreated separately on every set?"
> **Domain expert:** "No; **Metadata Field** definitions are reusable across the owning account and can be applied across sets and chapters."
>
> **Dev:** "If a reusable **Metadata Field** is renamed, do old uses keep the old label?"
> **Domain expert:** "No; renaming a reusable **Metadata Field** updates the canonical label used across its existing set-level and chapter-level values."

## Flagged ambiguities

- "rerun analysis" is not a product capability for comics; any reprocessing belongs to internal development or testing workflows, not the user-facing domain model.
- "ready" is overloaded: a **Set** can be playable before its **Breakdown** is complete, so playback readiness and analysis readiness must not be conflated.
- **Trash Window** and **Resubscribe Window** are different: the **Trash Window** applies only to intentional deletion by the user, while the **Resubscribe Window** is a seven-day payment-recovery lockout after a paid user stops paying.
