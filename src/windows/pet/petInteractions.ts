import { INTERACTIONS } from "./animationCatalog.js";
import { sendInteraction } from "./interactions.js";
import { getPetLayoutIndex, animatorForRemoteUser } from "./remotePets.js";
import type { PetAnimator } from "./petState.js";
import type { InteractionPayload } from "../../types";

type InteractionDef = (typeof INTERACTIONS)[keyof typeof INTERACTIONS];
type InteractionDefWithExtras = InteractionDef & { mirror?: string; holdMs?: number };

let getSelfAuthId: () => string | null = () => null;
let getSelfAnimator: () => PetAnimator | null = () => null;

export function initPetInteractions(opts: {
  getSelfAuthId: () => string | null;
  getSelfAnimator: () => PetAnimator;
}) {
  getSelfAuthId = opts.getSelfAuthId;
  getSelfAnimator = opts.getSelfAnimator;
}

function animatorForUser(userId: string): PetAnimator | null {
  const selfAuthId = getSelfAuthId();
  if (userId === selfAuthId || userId === "self") return getSelfAnimator();
  return animatorForRemoteUser(userId);
}

function playInteractionRole(
  def: InteractionDefWithExtras,
  state: string,
  userId: string,
  partnerId: string,
) {
  if (!state) return;
  const animator = animatorForUser(userId);
  if (!animator) return;
  const selfAuthId = getSelfAuthId();
  let mirrored = false;
  if (def.mirror === "facing") {
    const ownIndex = getPetLayoutIndex(userId, selfAuthId);
    const partnerIndex = getPetLayoutIndex(partnerId, selfAuthId);
    mirrored = ownIndex != null && partnerIndex != null && partnerIndex < ownIndex;
  }
  animator.playTransient(state, { durationMs: def.holdMs, mirrored });
}

export function applyInteraction({ action, actorId, targetId }: InteractionPayload) {
  const def =
    action in INTERACTIONS ? (INTERACTIONS[action as keyof typeof INTERACTIONS] as InteractionDefWithExtras) : null;
  if (!def) return;
  playInteractionRole(def, def.actorState, actorId, targetId);
  playInteractionRole(def, def.targetState, targetId, actorId);
}

export function triggerInteraction(action: keyof typeof INTERACTIONS, targetId: string) {
  const selfAuthId = getSelfAuthId();
  if (!(action in INTERACTIONS) || !selfAuthId) return;
  const payload: InteractionPayload = { action, actorId: selfAuthId, targetId };
  sendInteraction(payload);
  applyInteraction(payload);
}
