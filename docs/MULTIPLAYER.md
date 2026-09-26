# Multiplayer

Ascendant multiplayer uses **deterministic lockstep**. Every client runs the
full simulation; only player *commands* travel over the network. The sim is
already deterministic (seeded RNG stored in the save, no clocks or
`Math.random` in `src/sim`), so identical inputs at identical moments give
identical galaxies on every machine.

## Architecture

```
src/sim/cmd.ts        Command union + applyCommand(world, empire, cmd): every player action
src/net/transport.ts  Transport interface (room broadcast + presence)
src/net/local.ts      BroadcastChannel transport: tabs of one browser (no server)
src/net/supabase.ts   Supabase Realtime transport: broadcast + presence channel per room
src/net/memory.ts     In-memory transport for tests (manual flush, fault injection)
src/net/lockstep.ts   NetSession: lobby, lockstep clock, desync detection, resync, roster, chat
src/net/index.ts      Browser glue: client id, saved profile, transport choice, invite links
src/ui/screens/Lobby.tsx, src/ui/hud/NetPanel.tsx   UI
```

### Commands

Every UI action is a plain JSON `Command` (`src/sim/cmd.ts`) dispatched with
`dispatch(cmd)` from `src/ui/store.ts`:

- **single-player**: applied immediately with `applyCommand` (same behavior as before);
- **multiplayer**: sent to the host, executed later on every client; the
  result (and an error toast if it failed) comes back through the optional
  `then` callback.

`applyCommand` validates ownership — a player can only command their own
planets, fleets, designs, and proposals addressed to them. The `control`
command (AI takeover) is reserved for the session itself (`SYSTEM`).

`World.me` is the local player's empire (never serialized, never read by the
simulation). `world.human()` returns it when set, so every "your empire" UI
path shows the right seat on each client.

### Lockstep protocol

The **host** (room creator) owns the settings and the clock.

1. A player sends `cmd` to the host.
2. The host stamps it with an execution day — `day + inputDelay` (2) while
   time runs, or the current day while paused, never earlier than the previous
   stamp — and a global sequence number, and broadcasts `exec`.
3. The host broadcasts `tick {day, seq}` ("you may advance to `day`; every
   command stamped before it has sequence ≤ `seq`"), batched to ≤ ~7/s.
4. Each client applies every command stamped for its current day, in sequence
   order, before `advanceDay`, and never advances past the last tick. If a
   sequence number is missing it waits (and asks for a snapshot after 5 s).

Speed: any seated player can pause, resume, change speed, or step; requests go
to the host, which broadcasts the new speed. The host clock runs on
`setInterval`, so a host tab in the background keeps time flowing (browsers
throttle it to ~1 Hz there). If a connected player falls more than 90 days
behind, the host holds time until they catch up.

### Desync detection and resync

Every 25 days, right after advancing, each client hashes `serialize(world)`
(fast 64-bit string hash) and sends it to the host. On a mismatch the host
toasts, gzips its current state (`CompressionStream`), sends it in 60 KB
chunks, and the client swaps in the new world (the view remounts; selection is
kept). The same snapshot path serves **join-in-progress** and **reconnects**.

### Players coming and going

- **Lobby**: the host picks settings on the New Game screen ("Host a
  Multiplayer Game"); each joiner picks name / species / color and marks ready.
  Start generates the galaxy on every client from the same settings:
  `settings.players = [{species, name, color}, …]` makes empires `0..n-1`
  human (in lobby order) and the rest AI. Single-player (no `players`) is
  byte-for-byte unchanged.
- **Disconnect**: when a seated player vanishes from presence, the host issues
  `control {empire, human: false}` — the AI runs that empire (governors,
  research, fleets, diplomacy) until they return.
- **Rejoin**: a player id is stable per tab (`sessionStorage`), so reloading
  the page auto-rejoins the room, receives a snapshot, and gets the seat back
  (`control … human: true`). New ids joining a running game become spectators.
- **Host leaves** (or clicks *End session*): every client hands the other
  seats to the AI, saves the game as *"Online ROOM"* in its local save slots,
  and keeps playing offline. The host's reload therefore ends the session.

Victory: the game ends when someone wins, or when every human seat has fallen.

## Testing locally with two tabs (no server)

```bash
npm run dev
```

1. Open `http://localhost:5173/?net=local` → **Multiplayer** → *Set up
   galaxy…* → **Create room**. The URL now contains `?room=CODE`.
2. Open a **new tab** (not "Duplicate tab" — that copies the player id) at
   `http://localhost:5173/?room=CODE&net=local` (or use *Copy invite link*),
   pick a species, **Join**, **I'm ready**.
3. Host clicks **Start game**. Both tabs play the same galaxy; the top bar
   shows the room badge with players, ping, sync state and chat.

`?net=local` forces the BroadcastChannel transport even when Supabase is
configured. Place the two windows side by side: timers in fully hidden tabs
are throttled, so a hidden guest catches up in bursts.

Automated: `npx vitest run tests/net.test.ts` runs two in-memory clients
through the lockstep layer (200 days of commands from both sides → identical
state), a forced desync → resync, disconnect → AI → rejoin, and host leave.

## Playing over the internet (Supabase)

Supabase Realtime is only used as a relay — no tables, no auth, no server code.

1. Create a project at <https://supabase.com> (the free tier is fine).
2. In **Project Settings → API**, copy the **Project URL** and the
   **anon / publishable key**.
3. In **Realtime → Settings**, keep public channel access enabled (the default;
   the game uses public broadcast + presence channels named
   `ascendant:<ROOM>`). If you turn on "private channels only", you would need
   RLS policies on `realtime.messages` — not needed for this setup.
4. Create `.env.local` in the repo root:

   ```bash
   VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
   VITE_SUPABASE_ANON_KEY=YOUR-ANON-KEY
   ```

5. Restart `npm run dev` (or rebuild). The Multiplayer screen now offers
   **Internet (Supabase)** and uses it by default. Deploy the build anywhere
   static (the env vars are baked in at build time — the anon key is meant to
   be public).

## Limits

- **Trust**: the host is authoritative and every client runs the full sim,
  so a modified client can see everything (no fog-of-war secrecy) and a
  malicious host could cheat. Play with friends.
- **Room codes are the only access control**: anyone with the code can join
  as a spectator (seats are fixed at game start).
- **Host = session**: if the host closes or reloads, the online session ends
  (everyone keeps a local save). There is no host migration.
- **Up to 16 players**, limited by empire count (`floor(stars / 6)`).
- **"Until event"** pauses only single-player; online it just runs fast. Events
  still toast, but only explicit pauses stop shared time.
- **Snapshots** for resync/join are the gzipped save (typically 50–300 KB for
  medium galaxies) sent in 60 KB chunks; very large galaxies take a few
  seconds to resync over Supabase.
- **Supabase free tier** quotas (concurrent connections, messages/second)
  apply; a game sends roughly 7 ticks/s plus 1 ping/s per player.
- Loading a save or quitting to the menu leaves the online session.
