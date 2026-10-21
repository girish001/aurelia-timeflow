<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- The `/app` workspace is a client-only local demo: state lives in `src/lib/demo-store.ts` (localStorage, seeded fictional data) and the `/app` layout uses `ssr: false` — avoids hydration mismatch with browser-stored data; replace the store with Lovable Cloud before real customer use.
- Hour-entry rules live in `parseHours` (`src/lib/time.ts`) and are covered by `src/test/timeflow-rules.test.ts` — keep validation in one tested place.
