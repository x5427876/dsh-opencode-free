# Changelog

All notable user-visible changes to `dsh-opencode-free` are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The probe round now measures what it offers, and the panel says what a round
cost. Behaviour below is what a user can observe change.

### Added

- **Replies cut off at the budget are now counted, for free.** The output axis
  rests on a number nobody can verify by asking the model: has a reply ever
  wanted MORE than what the plugin sends? Synthetic generations answer it at tens
  of thousands of tokens each, and answer it unreliably — measured 2026-10-07, the
  same request produced 892 tokens once and 79,722 the next. Real traffic already
  carries the answer in `stopReason`, on a request that was happening anyway, so a
  reply that ends on `finish_reason: "length"` is counted per model and shown on
  its row. Replies cut by the CONTEXT clamp are counted apart, because a
  conversation running out of room says nothing about the output budget being
  small. Zero is the useful reading: it means the budget has not bound, so raising
  it would have bought nothing. The count is persisted, because a counter a
  restart erases cannot answer a question about days of use.
- **Sending no `max_tokens` at all does not work on this route.** Measured with
  the field stripped from the outgoing body and nothing else changed: Mimo
  returned nothing at all after 283 seconds, Longcat's reply changed shape
  entirely (7 seconds, ending on a tool call), and only Big Pickle behaved. A
  route that errors or reshapes when the parameter is absent has to be told what
  the ceiling is — which the harvested limit now supplies automatically.
- **A refused click says how long is left, in the right unit.** A wait of 60.7
  seconds was reported as "about 2 minutes" — `Math.ceil` rounding up a value that
  was under a minute told the reader to wait out a minute for a button that would
  still refuse. Under a minute is now reported in seconds.
- **Longcat's first watched generation is recorded.** Asked for 64,000 it produced
  64,000 with `finish_reason: "length"` in 947s (~67 tokens/second), so the panel
  can stop implying this model has never been watched writing a long reply. Its
  budget does not move: 262,144 is the ceiling the route itself named.
- **A row now answers "what is the limit" without arithmetic.** It read
  `输出预算 131,072 → 262,144`, `路由自述上限 262,144`, `实测产出 ≥64,000` — four
  figures and two arrows, every one of them true, and a reader still could not
  say what the plugin actually sends. The line now carries the values that are in
  effect (`上下文 1,000,000 · 输出 262,144`) and everything about where they came
  from is one hover away: the models.dev declaration it replaced, the ceiling the
  route named, the longest reply the model was watched writing, and how many real
  replies have been cut off at the budget. The strikethrough is gone from the open
  row — a struck-through number beside the live one reads as the value to anyone
  who has not internalised the convention.
- **The per-row tool badge is gone.** Measured over the live set: 9 of 12 rows
  carried it, two were unmeasured, and none ever lacked it. A mark that appears on
  every row asserts nothing a reader would not have assumed, and it takes the
  space a varying capability should have. Vision keeps its badge — seven models
  declare image input and five do not — and the tool measurement is not thrown
  away: it moves to the model name, which is the one element on a row that means
  "this model", so it is still one hover away and still testable. The card's
  footer legend now states the one genuinely special thing about tools here, once
  instead of per row: the free tier admits nothing unless the request carries
  `read` and `bash`, which is why the plugin adds them to every request.
- **The panel names WHICH source each number came from.** It carried four
  booleans computed as "differs from what models.dev published", so a ceiling the
  ROUTE stated in its own refusal, a figure a VENDOR published on its model page,
  a reply somebody watched finish, and a raise inferred from a clamp signature all
  rendered as the same word — "measured". That ambiguity is what produced "一百万输出
  明显不对", and it was ours. The card now says which, per axis: an unchanged
  number reads `declared`, and anything else names its source. No number changes;
  the sentence about it does.
- **The daily round learns each route's ceiling on its own.** The harvest ran only
  in a manual round — the capability questions shared the EFFORT axis's budget, and
  the daily round runs that at one — so a new model, or an upstream limit that
  changed, was only ever learned when the reader remembered to click. The two axes
  now have separate budgets. The declared-capability questions (vision, tools) stay
  on the manual round: they cost real output tokens, and the daily round covers
  models the user has switched off, which is not a bill worth paying daily.
- **Evidence survives a changed declaration instead of vanishing.** `limit.*` is a
  pointer to which model an id meant, and the pointer moves — models.dev fixes a
  typo, a publisher revises a number. A seed whose declaration no longer matches
  used to be dropped outright, so a typo fix silently deleted the only generation
  anyone had watched. It is demoted now: applied under the `declared x 4` valve,
  and labelled `inferred` so it stops claiming first-party evidence. A witnessed
  generation is kept and flagged as not re-checked rather than forgotten.
- **Capability evidence expires.** Vision and tools had no TTL while the effort
  axis always had one, so a months-old probe read exactly like today's and nothing
  could downgrade it. Thirty days, matching the effort clock: past it, the axis is
  asked again on the next manual round. With no clock supplied the age is not
  guessed at — the verdict stands, and the round is what re-asks.
- **The counter of replies cut off at the budget was never counting.** The outcome
  a finished request is recorded on was created, filled in by the payload hook and
  read by the stream wrapper — but the lookup that finds it had no caller from the
  commit that introduced it, so every real request returned early and nothing was
  observed. It also hung off `result()`, which the host never calls: DSH consumes
  the stream's iterator. So the "cut off" figure on a row was measuring nothing,
  and the first-token timing never existed. Both paths report now, and the count
  on screen means what it says.
- **A route that names no ceiling is asked once a day, not once a restart.** The
  harvest records "asked, and the route said nothing" so the next round knows it
  does not have to ask — but the record was rejected on read-back, so every
  restart spent a request per model to hear the same silence, on a shared
  anonymous bucket where a restart is not what changed the answer. The silence is
  now dated and kept for 24 hours. It still cannot become a measurement: an empty
  fingerprint matches no record, and the panel never shows it as a number.
- **A removal is final for a week, not for ever.** `nextProbeAt` was written into
  every `dead` record and never read, so a model retired on a wrong channel during
  an upstream outage stayed suppressed with no path back — and a name Zen
  re-published could never return. It is read now, and a death older than seven
  days is asked once more.
- **A region refusal says so.** "not available in your country" is the one failure
  with a one-line fix the reader can apply, and it was being filed as `unknown` or
  as a bad key. It is its own state now, and it renders among the caller-scoped
  conditions rather than as a failure of the model.
- **The panel row reports the limits the request actually uses, and says which
  of them were measured.** A row now shows the context window and the maximum
  output pi-ai clamps with, plus vision, thinking and tool-call badges — and a
  tick on anything that was verified on the route rather than copied from
  models.dev, with a replaced declaration struck through beside the number that
  replaced it. The card used to carry two booleans and a level, so a declared
  200,000 and a measured 1,048,576 were the same object on screen, and the panel
  could not disagree with the wire even in principle.
- **A round now measures the two capabilities it used to assume.** Given an
  image and asked to name its top half, a model answers or it does not; given
  real tool schemas — not the admission gate's "do not call" stubs — and asked
  to run one command, it emits a tool call or it does not. Each axis is asked
  once per model and the verdict is persisted, so a model you keep using costs
  nothing afterwards. A round that learns nothing writes nothing: the badge stays
  unmarked, because "we could not find out" and "it cannot" are different facts.
- **A round's cost is reported.** The report names how many requests it sent
  (a round may take several samples of one model, so the model count is not the
  bill) and how many models still owe samples.
- **A click that is refused says so.** Two clicks inside five minutes: the
  second is refused with the time remaining instead of starting a round.
- **A row that learned nothing names the condition inline** — `not measured ·
  quota spent`, `not measured · upstream overloaded`, `not measured ·
  endpoint unreachable` — rather than three identical words with the reason in a
  hover.

### Changed

- **`off` is measured, not assumed.** The round asks the model for no
  reasoning and for its own lowest level and compares the reasoning tokens
  against that model's own baseline. `off` is offered only when there is a
  real reduction: the exact `none` where the model reaches zero, otherwise the
  lowest level that measurably helps. A model that reduces nothing gets no `off`
  row at all, which withdraws the row rather than leaving a control that does
  nothing.
- **Probe now finishes a measurement.** A manual round keeps asking each model
  you have switched on until the axis has an answer (up to nine requests), so
  one click can complete it. The daily round still spends one request per
  model — but now covers every model Zen lists, including the ones you
  switched off, because a hidden model's status is what nobody would otherwise
  find out.
- **An unreachable endpoint and an overloaded upstream are named** instead of
  being reported as a model failure, and neither spends a second request on
  the other channel.
- **A model the upstream retires in words is removed.** `Model <id> has been
  deprecated` is treated as a positive answer, and a channel that answers
  nothing can no longer overrule a channel that named the model. Before this, a
  model Zen had explicitly retired sat in the picker as a red failure.

### Fixed

- **The probe read no reasoning counts at all**, so no capability row could
  ever be earned and repeated rounds changed nothing.
- **A model whose reasoning the route never reports is asked once and then
  left alone**, instead of being asked again at the full budget every round,
  forever.
- **A withdrawal visible in Zen's own list no longer lingers.** A model that
  answers `Model is unavailable.` on the channel it actually serves is removed.
- **A restored cache report can no longer overwrite a round that is running**,
  which made the panel sit still while the round you started ran on invisibly.
- **A measured context window that was an acceptance has been withdrawn.**
  `big-pickle`'s 1,048,576 came from "accepted, and refused at 1.5M and 2M" —
  refusals that named nothing. Hours later the same endpoint, asked for 2,000,000,
  said outright that its maximum context length is **262,139**, and by the next
  probe it was refusing requests as small as 210,000 while still answering 200,000
  a few minutes earlier. Advertising 1,048,576 meant DSH would compact at roughly
  839K estimated tokens and every request past the real ceiling would be
  refused — a model that looks like it broke, with nothing anywhere saying why.
  Its declaration ships again. The rule this earns: **seed a window only from a
  number the endpoint states about itself.** A refusal costs zero output tokens
  and returns a number; an acceptance costs nothing and returns nothing.
- **Measured context windows are used.** Where the endpoint has stated its own
  limit, that value is offered instead of models.dev's declaration, and a
  changed declaration discards it. A stated verdict keeps the samples behind
  it, so any verdict can be recomputed.
- **A reply could not outlast 180 seconds.** That timeout reached pi-ai as the
  SDK's whole-request deadline, and it was the wall before any max-output number
  mattered: measured 2026-10-07, asking Mimo V2.6 Flash for 34,000 or 40,000
  output tokens died at 181s with HTTP 200 and no usage frame, while the same
  request with a longer timeout produced all 40,000 at about 152 tokens/second.
  At that rate 180s bought roughly 27,000 tokens — less than the plugin used to
  advertise. The host profile's copy was the one that won, so both are now 600s,
  matching the profile's own stream idle timeout. Short replies are unaffected.
- **The plugin now learns each route's own limits instead of shipping a table.**
  A refusal costs zero output tokens and returns a number — "does not exceed
  262144" for output, "maximum context length of 262139" for context — so every
  probe round now asks once for the whole advertised window and reads whatever
  the refusal names, remembering it per model against a fingerprint of the
  declaration it was stated about. A changed declaration discards it. A route
  that answers instead of refusing is recorded as having stated nothing, and
  asked again next round, rather than guessed at. This is the mechanism that
  catches a stale declaration on its own: it is how Big Pickle's window turned
  out to be four times what the model really has. A stated ceiling outranks the
  seed tables, and a route that names nothing keeps models.dev's declaration.
  The detail row shows the interval rather than a single number — what a reply
  was watched writing, and what the route says it will not go past — because a
  ceiling was never one number.
- **A ceiling anyone STATES moves the output budget — vendor or route.**
  Xiaomi publishes [MiMo-V2.6-Flash](https://mimo.mi.com/models/en-US/mimo-v2.6-flash)
  as 1M context and **128K max output**; models.dev publishes 32,000, four times
  lower, and the same 1M context number the endpoint states in its own refusals.
  Longcat's route names its own ceiling outright — `/max_tokens: 995834 is not
  less or equal to 262144` — while models.dev publishes 131,072, half of it.
  Both statements cost zero output tokens (a refusal returns a number; a page is a
  page), and both now bound the budget. Ask the route for more than it will take
  and read the answer: asking for 8,000,000 was accepted by mimo, three
  Nemotron/Muse routes and refused by Longcat, which is how a 262,144 ceiling and
  an absent one look from the outside.
  Tested against the vendor's number: asked for 131,072, Mimo wrote 79,722 and
  stopped by itself (762s) — above its declared 32,000, below the published
  ceiling. The budget is 131,072 and the *observed* figure stays 64,000, because
  a published ceiling is a statement about what a model may write and not a reply
  anybody watched finish.
- **The output budget now follows models.dev, except where a generation was
  watched.** `limit.output` is the number every reply is cut at, and the route
  enforces it — so a declaration that is too low silently truncates a real reply
  at `finish_reason: "length"` with nothing reporting it. But acceptance is not
  capability: every route accepted budgets up to 1,040,384 on 2026-10-07 and no
  model has ever been seen writing that, so those numbers ship nowhere. One model
  has a watched generation — Mimo V2.6 Flash produced 40,000 output tokens when
  asked for more than it declares, and two have now been watched reaching it:
  Mimo V2.6 Flash produced 64,000 of a declared 32,000 (346s, ~185 tokens per
  second) and Big Pickle 48,000 of 32,000 (132s, ~365 tokens per second). The
  other nine budgets are exactly what models.dev publishes.
- **And it is labelled as a budget, not as a capability.** The route enforces
  `max_tokens` — asked for 8 with a prompt that wanted thousands, every model
  that answered stopped at exactly 8 with `finish_reason: "length"` — so a budget
  that is too low does cut real replies and raising it is right. But no model here
  writes a million tokens, and none has been seen to: the panel now names the
  number a budget and shows, separately and only where one exists, the longest
  reply a model has actually been watched producing (40,000 tokens, for Mimo V2.6
  Flash). The other seven have no such figure because no generation has been
  watched, and the row says nothing rather than inventing one. Time is the limit
  nobody sees: at about 150 tokens a second, the 10-minute request timeout ends a
  reply near 90,000 tokens whatever the budget says.

## [0.3.1] - 2026-10-03

Supports DeepSeek Harness `0.2.1-alpha.1`.

### Changed

- **Targets DeepSeek Harness `0.2.1-alpha.1`.** The peer pins move to
  `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-llm-pi-ai` `0.2.1-alpha.1` and
  `@deepseek-ai/schemastery` `~3.18.5-alpha.1` (the old `^3.18.3` range excludes
  that prerelease). The pin stays exact, so `0.2.0-rc.2` is no longer supported
  by this release; stay on `0.3.0` for it. DSH `0.2.1-alpha.1` keeps `pi-ai`
  `^0.87.1` and leaves `dsh-llm-pi-ai` unchanged; `dsh-llm` only drops its
  internal `INVARIANT` error code, so the plugin's behaviour is unchanged.

## [0.3.0] - 2026-10-02

The catalogue now follows models.dev, the availability check can be watched as it
runs, and a panel on the plugin's details page controls which models you see.

### Added

- **The model list follows [models.dev](https://models.dev).** Zen's own `/models`
  endpoint says which models exist; models.dev says which are free, what they are
  called, how large their context is, whether they take images, and which thinking
  levels each offers. A newly published free model appears without a plugin
  update, and a withdrawn one leaves on its own. Refreshed with one conditional
  request, so staying current costs no inference quota. Without a usable answer the
  plugin keeps serving its last known list, and then an offline floor — a failed or
  unreachable refresh changes nothing you can see.
- **An availability check you can watch run.** "Probe now" asks each model and
  reports as it goes: a progress pill counts down, the model being asked says so,
  the ones not reached yet are queued, and each row ends with its own outcome and
  how long it took. A round only spends a request on the models you have switched
  **on**, because a probe draws from a bucket shared by everything behind your
  egress IP.
- **A model visibility panel on the plugin's details page.** Every free model gets
  a switch; switched off, it leaves the picker and comes back when switched on. An
  id the catalogue no longer knows about is kept in the setting, so hiding a model
  and upgrading the plugin does not lose your choice.
- **Capability badges on every row** — vision support, context length, maximum
  output, and the strongest thinking level the model offers — taken from what
  models.dev publishes for that model rather than assumed.

### Changed

- **A model is removed only on a positive signal.** A text reply is `ok`; only a
  positive "this model is gone" is `dead`; anything else is `inconclusive` and the
  model stays. `dead` is reached only after every channel the provider implements
  has refused, and a channel that never answered — a dropped socket, a timeout —
  vetoes it rather than losing an argument. **A temporary network failure can no
  longer remove a model permanently.** The cost is deliberate: a model on a channel
  that times out keeps its place in the picker as a grey row.
- **A model is routed by the channel that actually worked.** The check asks each
  channel in turn, and a channel that answered is remembered — in the catalogue and
  across restarts — rather than re-inferred from a record that may describe the
  wrong one.
- **Probing stays sequential, and the button is not a repeat-click machine.** A
  manual round is floored at five minutes, because one round is up to 34 real
  requests against a shared bucket.
- **The round's report is persisted with its verdicts** and restored on restart, so
  the progress area shows the last outcome instead of appearing to have vanished.

### Fixed

- **A network blip is no longer read as "the anonymous tier refused us".** A socket
  error was caught by the identity guard's own fallback and the request re-sent
  without its credentials, which is exactly the diagnosis a dropped connection
  should not produce. Connection failures now name their cause — proxy, VPN,
  firewall or DNS — and never cost a second request.
- **A refusal names which upstream condition answered.** `FreeTierError` (free-tier
  admission refused), `MissingSessionID`, and "only the OpenCode client may send
  this" are told apart, because the reader's next move differs for each.
- **The availability check is admitted.** Its own request could lose the `read` and
  `bash` tool names the tier requires, and the upstream answered `403` to a request
  it would otherwise have served. The check re-asserts them on the final payload.
- **Images attached to a message reach the model.** They were resolved to nothing
  unconditionally, so every image was dropped before the request.
- **The visibility panel appears under the host's live config shape**, and a hidden
  model leaves the actual picker rather than only the plugin's own list.

### Known limitations

- **A model that Zen stops listing cannot be re-checked.** One judged gone and then
  dropped from Zen's own catalogue is neither visible nor eligible for a round, so
  the only way it returns is for Zen to list it again. Fixing this would mean
  re-probing models the catalogue no longer offers, at inference cost.
- **The anonymous tier is shared per egress IP and gated upstream without notice.**
  It can refuse at any time; an optional API key raises the limit.
- **The check spends quota.** One round asks every visible model once. The daily
  round runs at most once per local day; the button is floored at five minutes.

### Design rationale

`docs/adr/0002-catalogue-source-of-truth.md` records the final decisions and the
evidence behind them, including two questions where measurement overruled the
original recommendation.