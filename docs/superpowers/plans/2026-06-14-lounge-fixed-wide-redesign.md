# Lounge Fixed-Wide Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the lounge as a fixed-wide desktop master-detail panel with profile controls, `gp_` short-ID invitations, editable room metadata, member pet avatars, online labels, and enter/exit room state.

**Architecture:** Keep the existing Vite + vanilla JS + Tauri v2 structure. Split lounge rendering into small view/helper modules, keep Supabase data access in `src/windows/lounge/lounge.js`, and add a minimal event bridge between the pet window and lounge window for active-room state.

**Tech Stack:** Vite, vanilla ES modules, Vitest, Tauri v2 events, Supabase Postgres/RLS, Supabase connector for schema inspection.

---

## Supabase Connector Findings

The Supabase connector was used on 2026-06-14 against project `mrvdeeiiwnegaqjwpsgk`.

Current relevant schema:

- `profiles`: has `id`, `gp_id`, `display_name`, `pet_id`, `created_at`; missing `skin`.
- `rooms`: has `id`, `invite_code`, `created_by`, `created_at`, `room_name`; missing `description`.
- `room_members`: has `room_id`, `user_id`, `joined_at`.
- `presence`: has `room_id`, `user_id`, `is_online`, `last_seen`.
- `rooms` currently has `SELECT` and `INSERT` policies, but no `UPDATE` policy. Editing room name/description by any member needs a new `rooms_update` policy.
- RPCs/functions exist for `accept_connection(uuid)` and `join_room_by_invite(text)`.

Implementation must re-check these before applying DDL because Supabase state may change.

## File Structure

Files to modify:

- `windows/lounge.html` — move user profile markup into the sidebar, remove the top header, add member-list invite icon and editable room metadata anchors.
- `src/windows/lounge/lounge.css` — replace topbar layout with fixed-wide two-column panel; add icon buttons, profile card, editable labels, member row, online badges, invite modal styles.
- `src/windows/lounge/lounge-main.js` — pass active room state and enter/exit handlers into lounge; listen for pet-window active-room changes.
- `src/windows/lounge/lounge.js` — expand data loading, profile/room editing, `gp_` invitation lookup, active-room rendering state, and modal behavior.
- `src/windows/lounge/views/room-list.js` — render rooms and pending invitations under the room list.
- `src/windows/lounge/views/room-detail.js` — render editable room title/description, sorted members, invite icon, and enter/exit action.
- `src/windows/pet/main.js` — listen for lounge room-state requests and exit-room events; emit active room changes.
- `src/windows/pet/renderer.js` — expose current room id and add a room-exit function that leaves realtime channels/presence safely.
- `src-tauri/src/lib.rs` — set the dynamically-created lounge window minimum size.
- `docs/database.md` — document `rooms.description`, `profiles.skin`, the `rooms_update` policy, and invitation-first product flow.

Files to create:

- `src/windows/lounge/views/profile-card.js` — render current user profile controls.
- `src/windows/lounge/views/pet-avatar.js` — render idle pet avatar with fallback.
- `src/windows/lounge/loungeViewModels.js` — pure helpers for `gp_` normalization, display names, member sorting, and room action labels.
- `src/windows/lounge/loungeViewModels.test.js` — Vitest coverage for helper behavior.
- A timestamped `supabase/migrations/*_lounge_room_profile_fields.sql` file — generated through `supabase migration new lounge_room_profile_fields`.

## Task 1: Re-check Supabase Schema and Add Missing Fields/Policy

**Files:**
- Create: timestamped `supabase/migrations/*_lounge_room_profile_fields.sql` from Step 2
- Modify: `docs/database.md`

- [ ] **Step 1: Re-check schema with Supabase connector**

Use the Supabase connector to list `public.profiles`, `public.rooms`, `public.room_members`, `public.presence`, and current `pg_policies`.

Expected facts before migration:

```text
profiles.skin: missing
rooms.description: missing
rooms.room_name: present
rooms_update policy: missing
```

If any expected fact has changed, update this task before applying DDL.

- [ ] **Step 2: Create a migration file**

Run:

```bash
cd /Users/nanshine/PlayGround/GoodPuppy
supabase migration new lounge_room_profile_fields
```

Expected: Supabase CLI creates a timestamped file under `supabase/migrations/` ending in `_lounge_room_profile_fields.sql`.

- [ ] **Step 3: Write the migration SQL**

Put this SQL in the generated migration file:

```sql
alter table public.rooms
  add column if not exists description text not null default '';

alter table public.profiles
  add column if not exists skin text not null default 'default';

create policy rooms_update
on public.rooms
for update
to authenticated
using (id in (select private.get_my_room_ids()))
with check (id in (select private.get_my_room_ids()));
```

If `rooms_update` already exists when implementing, replace the `create policy` statement with:

```sql
drop policy if exists rooms_update on public.rooms;

create policy rooms_update
on public.rooms
for update
to authenticated
using (id in (select private.get_my_room_ids()))
with check (id in (select private.get_my_room_ids()));
```

- [ ] **Step 4: Apply and verify the migration**

Use the Supabase connector migration tool or the project’s established Supabase migration workflow. After applying, verify with connector/table inspection:

```text
profiles.skin exists, text, default 'default'
rooms.description exists, text, default ''
rooms_update exists and permits authenticated room members to update rooms they belong to
```

- [ ] **Step 5: Update `docs/database.md`**

Update the `profiles` and `rooms` table definitions:

```sql
skin text NOT NULL DEFAULT 'default'
description text NOT NULL DEFAULT ''
```

Also update the room-entry description to say the product UI is invitation-first by `gp_` short ID; invite-code join remains a compatibility/RPC path, not the primary lounge UI path.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations docs/database.md
git commit -m "db: add lounge room metadata fields"
```

## Task 2: Add Lounge View-Model Helpers

**Files:**
- Create: `src/windows/lounge/loungeViewModels.js`
- Create: `src/windows/lounge/loungeViewModels.test.js`

- [ ] **Step 1: Write failing tests**

Create `src/windows/lounge/loungeViewModels.test.js`:

```js
import { describe, expect, it } from "vitest";
import {
  buildMemberViewModels,
  getDisplayName,
  getRoomAction,
  normalizeGpId,
} from "./loungeViewModels.js";

describe("normalizeGpId", () => {
  it("keeps gp-prefixed short ids and trims whitespace", () => {
    expect(normalizeGpId("  gp_a1b2c3d4  ")).toBe("gp_a1b2c3d4");
  });

  it("rejects auth uuids and non-gp ids", () => {
    expect(normalizeGpId("a1b2c3d4-0000-0000-0000-000000000000")).toBe("");
    expect(normalizeGpId("user_a")).toBe("");
  });
});

describe("getDisplayName", () => {
  it("prefers display_name and falls back to gp_id", () => {
    expect(getDisplayName({ display_name: "Nana", gp_id: "gp_12345678" })).toBe("Nana");
    expect(getDisplayName({ display_name: "", gp_id: "gp_12345678" })).toBe("gp_12345678");
  });
});

describe("buildMemberViewModels", () => {
  it("sorts the current user first and keeps other members stable", () => {
    const members = [
      { user_id: "u2", joined_at: "2026-06-12T00:00:00Z", profiles: { gp_id: "gp_b", display_name: "B" } },
      { user_id: "u1", joined_at: "2026-06-13T00:00:00Z", profiles: { gp_id: "gp_a", display_name: "A" } },
      { user_id: "u3", joined_at: "2026-06-11T00:00:00Z", profiles: { gp_id: "gp_c", display_name: "C" } },
    ];
    const presence = [{ user_id: "u3", is_online: true }];

    expect(buildMemberViewModels(members, presence, "u1").map((member) => member.userId)).toEqual([
      "u1",
      "u3",
      "u2",
    ]);
  });
});

describe("getRoomAction", () => {
  it("returns exit for active room and enter otherwise", () => {
    expect(getRoomAction("room-1", "room-1")).toEqual({ action: "exit", label: "退出房间" });
    expect(getRoomAction("room-2", "room-1")).toEqual({ action: "enter", label: "进入房间" });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
npm run test -- src/windows/lounge/loungeViewModels.test.js
```

Expected: FAIL because `loungeViewModels.js` does not exist.

- [ ] **Step 3: Implement helpers**

Create `src/windows/lounge/loungeViewModels.js`:

```js
const GP_ID_PATTERN = /^gp_[a-z0-9]{8,}$/i;

export function normalizeGpId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return GP_ID_PATTERN.test(normalized) ? normalized : "";
}

export function getDisplayName(profile = {}) {
  const name = String(profile.display_name || "").trim();
  return name || profile.gp_id || "GoodPuppy";
}

function joinedAtValue(member) {
  const time = Date.parse(member.joined_at || "");
  return Number.isNaN(time) ? 0 : time;
}

export function buildMemberViewModels(members = [], presenceRows = [], selfAuthId) {
  const presenceByUser = new Map(presenceRows.map((row) => [row.user_id, row]));

  return [...members]
    .sort((a, b) => {
      if (a.user_id === selfAuthId) return -1;
      if (b.user_id === selfAuthId) return 1;
      return joinedAtValue(a) - joinedAtValue(b);
    })
    .map((member) => {
      const profile = member.profiles || {};
      const presence = presenceByUser.get(member.user_id);
      return {
        userId: member.user_id,
        gpId: profile.gp_id || "",
        displayName: getDisplayName(profile),
        petId: profile.pet_id || "default",
        skin: profile.skin || "default",
        isSelf: member.user_id === selfAuthId,
        isOnline: Boolean(presence?.is_online),
      };
    });
}

export function getRoomAction(selectedRoomId, activeRoomId) {
  if (selectedRoomId && selectedRoomId === activeRoomId) {
    return { action: "exit", label: "退出房间" };
  }
  return { action: "enter", label: "进入房间" };
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test -- src/windows/lounge/loungeViewModels.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/windows/lounge/loungeViewModels.js src/windows/lounge/loungeViewModels.test.js
git commit -m "test: add lounge view model helpers"
```

## Task 3: Render Profile Card and Pet Avatars

**Files:**
- Create: `src/windows/lounge/views/profile-card.js`
- Create: `src/windows/lounge/views/pet-avatar.js`
- Modify: `windows/lounge.html`
- Modify: `src/windows/lounge/lounge.js`

- [ ] **Step 1: Create `pet-avatar.js`**

```js
import { getStateImagePath } from "../../pet/animationCatalog.js";

export function createPetAvatar({ petId = "default", skin = "default", alt = "" } = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "pet-avatar";

  const img = document.createElement("img");
  img.className = "pet-avatar-image";
  img.alt = alt;
  img.draggable = false;
  img.src = getStateImagePath(petId, "idle", skin);
  img.addEventListener("error", () => {
    wrapper.classList.add("is-fallback");
    img.remove();
    wrapper.textContent = "GP";
  }, { once: true });

  wrapper.appendChild(img);
  return wrapper;
}
```

- [ ] **Step 2: Create `profile-card.js`**

```js
import { createPetAvatar } from "./pet-avatar.js";

export function renderProfileCard(profile) {
  const root = document.querySelector(".lounge-profile-card");
  if (!root) return;

  root.innerHTML = "";
  root.appendChild(createPetAvatar({
    petId: profile?.pet_id,
    skin: profile?.skin,
    alt: profile?.display_name || "GoodPuppy",
  }));

  const body = document.createElement("div");
  body.className = "profile-body";
  body.innerHTML = `
    <div class="profile-name-row">
      <button class="profile-name lounge-edit-display-name" type="button"></button>
      <button class="icon-btn lounge-edit-name-btn" type="button" aria-label="编辑用户名">✎</button>
    </div>
    <div class="profile-id-row">
      <span class="profile-id-label">ID</span>
      <span class="profile-id lounge-gp-id"></span>
      <button class="icon-btn lounge-copy-id-btn" type="button" data-copy="gp-id" aria-label="复制 ID">⧉</button>
    </div>
  `;
  body.querySelector(".profile-name").textContent = profile?.display_name || "GoodPuppy";
  body.querySelector(".profile-id").textContent = profile?.gp_id || "";
  root.appendChild(body);
}
```

- [ ] **Step 3: Update `windows/lounge.html` structure**

Move the user profile markup into `.sidebar` above `.sidebar-head`, replace the old SVG avatar/topbar copy button with:

```html
<section class="profile-section" data-tauri-drag-region>
  <div class="lounge-profile-card"></div>
  <button class="icon-btn lounge-settings-btn" type="button" aria-label="设置">⚙</button>
</section>
```

Remove the `.topbar` block and change `.app-window` to a single-row layout.

- [ ] **Step 4: Wire profile rendering in `lounge.js`**

Import and call:

```js
import { renderProfileCard } from "./views/profile-card.js";

function renderProfile(profile) {
  renderProfileCard(profile);
}
```

- [ ] **Step 5: Commit**

```bash
git add windows/lounge.html src/windows/lounge/lounge.js src/windows/lounge/views/profile-card.js src/windows/lounge/views/pet-avatar.js
git commit -m "feat: render lounge profile card"
```

## Task 4: Load Presence, Skin, and Member View Models

**Files:**
- Modify: `src/windows/lounge/lounge.js`
- Modify: `src/windows/lounge/views/room-detail.js`

- [ ] **Step 1: Expand profile and member selects**

In `loadPanelData()`, change profile select to:

```js
_supabase.from("profiles").select("id, gp_id, display_name, pet_id, skin").eq("id", _selfAuthId).single()
```

Change member select to:

```js
.from("room_members")
.select("room_id, user_id, joined_at, profiles!room_members_user_id_fkey(id, gp_id, display_name, pet_id, skin)")
.in("room_id", roomIds)
```

- [ ] **Step 2: Load presence rows**

After `roomIds` are known:

```js
let allPresence = [];
if (roomIds.length > 0) {
  const { data, error } = await _supabase
    .from("presence")
    .select("room_id, user_id, is_online, last_seen")
    .in("room_id", roomIds);
  if (error) throw error;
  allPresence = data || [];
}
```

- [ ] **Step 3: Build member view models per room**

Import `buildMemberViewModels` and map rooms with:

```js
members: buildMemberViewModels(
  allMembers.filter((member) => member.room_id === item.room_id),
  allPresence.filter((presence) => presence.room_id === item.room_id),
  _selfAuthId,
),
```

- [ ] **Step 4: Update `renderRoomDetail()` member rendering**

Render from view models:

```js
for (const member of room.members) {
  const item = document.createElement("div");
  item.className = "member";
  item.appendChild(createPetAvatar({ petId: member.petId, skin: member.skin, alt: member.displayName }));
  item.insertAdjacentHTML("beforeend", `
    <div class="member-copy">
      <div class="member-name" title="${member.gpId}">${member.displayName}</div>
      <div class="member-id">${member.gpId}</div>
    </div>
    <span class="status-badge ${member.isOnline ? "is-online" : "is-offline"}">${member.isOnline ? "在线" : "离线"}</span>
    ${member.isSelf ? `<span class="badge">你</span>` : ""}
  `);
  members.appendChild(item);
}
```

- [ ] **Step 5: Run focused tests**

```bash
npm run test -- src/windows/lounge/loungeViewModels.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/windows/lounge/lounge.js src/windows/lounge/views/room-detail.js
git commit -m "feat: show lounge member profiles"
```

## Task 5: Add Profile, Room, and Invitation Actions

**Files:**
- Modify: `src/windows/lounge/lounge.js`
- Modify: `src/windows/lounge/views/room-detail.js`
- Modify: `src/windows/lounge/views/room-list.js`

- [ ] **Step 1: Change invitation lookup to `gp_id`**

Replace target lookup in `inviteMember()` with:

```js
const gpId = normalizeGpId(targetGpId);
if (!gpId) throw new Error("请输入 gp_ 开头的 GoodPuppy ID");

const { data: target, error: lookupError } = await _supabase
  .from("profiles")
  .select("id")
  .eq("gp_id", gpId)
  .single();
```

Keep `connection_requests.to_id = target.id`.

- [ ] **Step 2: Add username editing**

Add:

```js
async function updateDisplayName(displayName) {
  const value = displayName.trim();
  if (!value) throw new Error("请输入用户名");

  const { error } = await _supabase
    .from("profiles")
    .update({ display_name: value })
    .eq("id", _selfAuthId);
  if (error) throw error;

  setMessage("用户名已更新");
  await loadPanelData();
}
```

Bind `.lounge-edit-name-btn` and `.lounge-edit-display-name` to:

```js
function openDisplayNameEditor() {
  const profileName = document.querySelector(".lounge-edit-display-name")?.textContent || "";
  openInputModal({
    title: "编辑用户名",
    placeholder: "输入用户名",
    submitText: "保存",
    validate: (value) => (!value.trim() ? "请输入用户名" : ""),
    onSubmit: updateDisplayName,
    initialValue: profileName,
  });
}
```

Extend `openInputModal()` so it accepts `initialValue`:

```js
function openInputModal({ title, placeholder, submitText = "确定", initialValue = "", validate, onSubmit }) {
```

Replace the current empty-value assignment:

```js
input.value = "";
```

with:

```js
input.value = initialValue;
```

- [ ] **Step 3: Add room metadata editing for all members**

Add:

```js
async function updateSelectedRoomMetadata({ roomName, description }) {
  const room = getSelectedRoom();
  if (!room) return;

  const { error } = await _supabase
    .from("rooms")
    .update({
      room_name: roomName.trim() || "未命名房间",
      description: description.trim(),
    })
    .eq("id", room.id);
  if (error) throw error;

  setMessage("房间信息已更新");
  await loadPanelData();
}
```

Add a dedicated room metadata modal:

```js
function openRoomMetadataModal() {
  const room = getSelectedRoom();
  if (!room) return;

  const backdrop = modalBackdrop();
  const form = modalForm();
  if (!backdrop || !form) return;

  form.innerHTML = `
    <h2 class="modal-title">编辑房间信息</h2>
    <input class="lounge-input lounge-room-name-input" name="room-name" autocomplete="off" />
    <textarea class="lounge-input lounge-room-description-input" name="room-description" rows="4"></textarea>
    <p class="lounge-form-message" role="status"></p>
    <div class="lounge-form-actions">
      <button class="small-btn lounge-form-cancel" type="button">取消</button>
      <button class="small-btn primary lounge-form-submit" type="submit">保存</button>
    </div>
  `;

  form.querySelector(".lounge-room-name-input").value = room.room_name || "";
  form.querySelector(".lounge-room-description-input").value = room.description || "";
  backdrop.hidden = false;

  const close = () => {
    backdrop.hidden = true;
    form.onsubmit = null;
  };

  form.querySelector(".lounge-form-cancel").onclick = close;
  form.onsubmit = async (event) => {
    event.preventDefault();
    setModalBusy(true);
    try {
      await updateSelectedRoomMetadata({
        roomName: form.querySelector(".lounge-room-name-input").value,
        description: form.querySelector(".lounge-room-description-input").value,
      });
      close();
    } catch (error) {
      setModalMessage(error.message || "保存失败");
    } finally {
      setModalBusy(false);
    }
  };
}
```

Bind the room edit icon in `room-detail.js` to `.lounge-edit-room`. Do not restrict by `created_by`.

- [ ] **Step 4: Move invite action to member-list plus icon**

In `room-detail.js`, render the member section heading with:

```html
<button class="icon-btn lounge-invite-member" type="button" aria-label="邀请成员">+</button>
```

Remove the large invite button from the bottom actions.

- [ ] **Step 5: Remove join-room UI path**

Remove `.lounge-join-room` from `windows/lounge.html` and remove its event binding in `lounge.js`. Do not delete `joinRoomByInvite()` yet unless no tests/imports use it.

- [ ] **Step 6: Commit**

```bash
git add src/windows/lounge/lounge.js src/windows/lounge/views/room-detail.js src/windows/lounge/views/room-list.js windows/lounge.html
git commit -m "feat: add lounge edit and invite actions"
```

## Task 6: Add Active Room Enter/Exit State

**Files:**
- Modify: `src/windows/lounge/lounge-main.js`
- Modify: `src/windows/lounge/lounge.js`
- Modify: `src/windows/lounge/views/room-detail.js`
- Modify: `src/windows/pet/main.js`
- Modify: `src/windows/pet/renderer.js`

- [ ] **Step 1: Expose active room state from pet renderer**

In `src/windows/pet/renderer.js`, add:

```js
export function getCurrentRoomId() {
  return currentRoomId;
}

export async function exitCurrentRoom() {
  if (!currentRoomId) return;
  await leaveInteractions();
  await presence.leaveRoom();
  currentRoomId = null;
  clearRemotePets();
}
```

Add this helper near the existing `remotePets` map helpers:

```js
function clearRemotePets() {
  for (const entry of remotePets.values()) {
    if (entry.removeTimer != null) clearTimeout(entry.removeTimer);
    entry.animator.destroy();
    entry.element.remove();
  }
  remotePets.clear();
  relayoutRemotePets();
}
```

- [ ] **Step 2: Wire Tauri events in `pet/main.js`**

Import the new exports:

```js
import { exitCurrentRoom, getCurrentRoomId, startPetApp, switchRoom } from "./renderer.js";
```

Add listeners:

```js
listen("request-active-room", () => {
  emit("active-room-changed", { roomId: getCurrentRoomId() });
});

listen("exit-room", async () => {
  await exitCurrentRoom();
  emit("active-room-changed", { roomId: getCurrentRoomId() });
});
```

After successful `switchRoom(event.payload.roomId)`, emit:

```js
emit("active-room-changed", { roomId: getCurrentRoomId() });
```

- [ ] **Step 3: Track active room in lounge**

In `lounge-main.js`, keep:

```js
let activeRoomId = null;
```

Pass handlers:

```js
initLoungePanel({
  supabase,
  selfAuthId,
  getActiveRoomId: () => activeRoomId,
  onEnterRoom: (roomId) => {
    getCurrentWindow().hide();
    emit("switch-room", { roomId });
  },
  onExitRoom: () => emit("exit-room"),
});
```

Listen:

```js
listen("active-room-changed", (event) => {
  activeRoomId = event.payload?.roomId || null;
  openLoungePanel({ activeRoomId });
});
```

On lounge open, request current state:

```js
emit("request-active-room");
```

- [ ] **Step 4: Render enter/exit button**

Use `getRoomAction(selectedRoomId, activeRoomId)` inside `renderRoomDetail()` and set:

```js
button.dataset.action = roomAction.action;
button.textContent = roomAction.label;
```

In `lounge.js`, route click:

```js
if (btn.dataset.action === "exit") {
  _onExitRoom?.();
  setMessage("已退出房间");
  return;
}
_onEnterRoom?.(room.id);
```

- [ ] **Step 5: Commit**

```bash
git add src/windows/lounge/lounge-main.js src/windows/lounge/lounge.js src/windows/lounge/views/room-detail.js src/windows/pet/main.js src/windows/pet/renderer.js
git commit -m "feat: track active lounge room"
```

## Task 7: Rebuild Fixed-Wide Lounge CSS

**Files:**
- Modify: `src/windows/lounge/lounge.css`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Remove topbar grid and make app two-column**

Set:

```css
.app-window {
  width: min(1120px, 100%);
  height: min(720px, calc(100vh - 56px));
  min-width: 1040px;
  min-height: 680px;
  display: grid;
  grid-template-columns: 340px 1fr;
  grid-template-rows: 1fr;
}

.layout {
  display: contents;
}
```

- [ ] **Step 2: Add profile and icon button styles**

Add:

```css
.profile-section {
  display: grid;
  grid-template-columns: 1fr 38px;
  gap: 12px;
  align-items: start;
  margin-bottom: 28px;
}

.lounge-profile-card {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
}

.pet-avatar {
  width: 58px;
  height: 58px;
  border-radius: 50%;
  overflow: hidden;
  display: grid;
  place-items: center;
  background: #f6efe6;
  border: 1px solid #ece5db;
}

.pet-avatar-image {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
```

- [ ] **Step 3: Add member/action styles**

Add status badges and member row layout:

```css
.member {
  min-height: 64px;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
}

.status-badge.is-online {
  color: #137a45;
  background: #e7f7ee;
}

.status-badge.is-offline {
  color: #777;
  background: #eeeeec;
}
```

- [ ] **Step 4: Set lounge min size in Tauri window builder**

In `src-tauri/src/lib.rs`, update the dynamic lounge window builder:

```rust
.inner_size(1120.0, 720.0)
.min_inner_size(1040.0, 680.0)
.resizable(true)
```

- [ ] **Step 5: Commit**

```bash
git add src/windows/lounge/lounge.css src-tauri/src/lib.rs
git commit -m "style: rebuild fixed-wide lounge layout"
```

## Task 8: Verify and Finalize

- [ ] **Step 1: Run unit tests**

```bash
npm run test
```

Expected: PASS.

- [ ] **Step 2: Run production build**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Run security/performance advisors after DDL**

Use Supabase connector advisors for project `mrvdeeiiwnegaqjwpsgk`:

```text
security advisors: no new critical/high issue caused by rooms/profiles policy changes
performance advisors: no new issue caused by new fields/policy
```

If advisors report policy or RLS issues related to this change, fix the migration/policy and re-run advisors.

- [ ] **Step 4: Manual UI check**

Run:

```bash
npm run dev
```

Open `http://localhost:1420/windows/lounge.html` and verify:

- left sidebar contains profile card, rooms, then pending invitations;
- username edit icon opens edit modal;
- ID copy icon copies a `gp_` short ID;
- member list shows current user first;
- member list invite plus icon opens `gp_` short-ID invitation modal;
- selected active room shows `退出房间`, inactive rooms show `进入房间`;
- no `加入房间` button is visible.

- [ ] **Step 5: Commit final fixes**

```bash
git status --short
git add windows/lounge.html src/windows/lounge src/windows/pet/main.js src/windows/pet/renderer.js src-tauri/src/lib.rs docs/database.md supabase/migrations
git commit -m "chore: verify lounge redesign"
```
