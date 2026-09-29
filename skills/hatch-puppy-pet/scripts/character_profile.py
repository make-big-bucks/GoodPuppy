"""Small run-level art direction schema and anatomy-neutral state choreography."""
from __future__ import annotations

from puppy_states import REQUIRED_STATES, IDLE_VARIANT_POOL, state_records, configure_states

STYLES = {
    'auto': 'Follow the user references and requested style; otherwise use a compact flat cartoon. Keep an opaque, clean silhouette suitable for GIF transparency.',
    'pixel': 'Limited palette, stepped edges, simple flat shading and readable pixel clusters.',
    'sticker': 'Bold sticker-like silhouette, expressive face, clean opaque contours; no sticker sheet or background.',
    'flat-vector': 'Simple geometric shapes and flat color areas, consistent outline treatment, raster sprite output.',
    'clay': 'Rounded clay-toy forms with restrained material shading and clean opaque contours; no floor or cast shadow.',
    '3d-toy': 'Stylized toy volumes with consistent soft internal shading and a clean opaque silhouette; no scene or floor shadow.',
    'plush': 'Simplified plush mascot with broad fabric cues; no fine loose fibers or translucent fuzzy silhouette.',
    'painterly': 'Simplified painted mascot with broad color shapes, controlled internal brushwork and clean opaque contours.',
}

ACTIONS = {
    'idle': 'Quiet breathing and a blink; six visibly distinct micro-poses, no large gesture. First pose is a useful still.',
    'drag-lift': 'Invisible grip lifts the character: existing limbs or flexible body tips dangle, paddle and recover. Direction-neutral front or three-quarter view; no drawn hand.',
    'message': 'One paper plane: hold against an existing appendage or body, anticipate, toss upward, watch it go. Only final 1–2 poses may show a detached plane; the final pose settles.',
    'cuddle': 'Lean and gently squash toward the RIGHT contact edge, then softly breathe against it. Keep the complete silhouette visible with 3px clearance. No wall or partner. Preserve the rightward position, not centered poses.',
    'cast': 'One small wand stays held against an existing appendage or body: prepare, raise, two flourishes, lower. At most one opaque spark touching its tip.',
    'feed': 'One compact food pack close to the character: notice, lean in, eat as it shrinks, finish satisfied. No feeding hand or crumbs.',
    'kicked': 'Anticipate impact, launch, tumble, land, recover dazed. Preserve actual vertical and horizontal travel inside the slot. No actor, impact marks or trails.',
    'enter': 'One compact door: first pose door only, open, character emerges overlapping doorway, door disappears, final character pose matches idle. Same door design as leave.',
    'greet': 'Acknowledge a friend with an existing limb, wing, body tip or body tilt: prepare, gesture, expressive hold, recover. Do not add anatomy.',
    'leave': 'One compact door matching enter: appear beside character, open, character enters while overlapping door, final pose closed door only.',
    'happy': 'Personality-specific cheerful bounce or wiggle; clear anticipation and recovery, closed loop.',
    'sad': 'Lower posture and gaze, small sigh, recover into a quiet loop. No invented ears; tears only if touching the face.',
    'busy': 'One tiny laptop touching the body: turn partly away, focus downward and work with existing anatomy, never look up. No readable screen content or glow.',
    'bored': 'Listless posture, slow glance and sigh, recover into a loop distinct from sad and idle.',
}


def validate_profile(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise SystemExit('character profile must be a JSON object')
    allowed = {'identity', 'anatomy', 'personality', 'motion', 'props', 'style_preset', 'actions', 'idle_variants', 'pilot_state'}
    if set(raw) - allowed:
        raise SystemExit('unknown profile fields: ' + ', '.join(sorted(set(raw) - allowed)))
    profile = dict(raw)
    for key in ('identity', 'anatomy', 'personality', 'motion', 'props'):
        if key in profile and (not isinstance(profile[key], str) or not profile[key].strip()):
            raise SystemExit(f'{key} must be a nonempty string')
    if profile.get('style_preset', 'auto') not in STYLES:
        raise SystemExit('unknown style_preset')
    actions = profile.get('actions', {})
    if not isinstance(actions, dict) or any(not isinstance(v, str) or not v.strip() for v in actions.values()):
        raise SystemExit('actions must map state names to nonempty choreography notes')
    if not isinstance(profile.get('idle_variants', []), list):
        raise SystemExit('idle_variants must be a list of pool names or custom state objects')
    return profile


def select_states(profile: dict, selection: str | None) -> None:
    pool = {entry[0]: entry for entry in IDLE_VARIANT_POOL}
    variants = ([n.strip() for n in selection.split(',') if n.strip()] if selection is not None
                else profile.get('idle_variants', ['idle-stretch', 'idle-shake']))
    records = state_records(REQUIRED_STATES)
    for item in variants:
        if isinstance(item, str) and item in pool:
            records.extend(state_records([pool[item]]))
        elif isinstance(item, dict):
            if not str(item.get('state', '')).startswith('idle-'):
                raise SystemExit('custom variants must use idle-* names')
            records.append(item)
        else:
            raise SystemExit(f'unknown idle variant: {item}')
    configure_states(records)
    names = {row['state'] for row in records}
    if set(profile.get('actions', {})) - names:
        raise SystemExit('profile actions reference states not selected for this run')
    if profile.get('pilot_state', 'enter') not in names - {'idle'}:
        raise SystemExit('pilot_state must be a selected non-idle state')


def character_notes(profile: dict) -> str:
    return '\n'.join(f'{key.capitalize()}: {profile[key]}' for key in ('identity', 'anatomy', 'personality', 'motion', 'props') if profile.get(key))
