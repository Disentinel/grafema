/**
 * Constants for Civ-map visualization.
 *
 * Color maps, LOD thresholds, visual style (dark neon theme),
 * hex geometry, pin markers, and rendering limits.
 */

export const BACKGROUND = 0x0a0e14;
export const ACCENT = 0x00e5ff;
export const ACCENT_HEX = '#00e5ff';

// LOD thresholds (camera distance)
export const LOD = {
    PACKAGES_ONLY: 1500,
    DIRECTORIES: 600,
    FILES: 200,
    FUNCTIONS: 50,
    ALL: 0,
};

// Transition speed (ms)
export const LOD_TRANSITION_MS = 300;

// Node type colors — HSL lightness modifiers for type variety within regions
export const TYPE_LIGHTNESS = {
    FUNCTION: 45, METHOD: 45, CLASS: 55, INTERFACE: 55,
    VARIABLE: 35, CONSTANT: 40, PARAMETER: 30,
    CALL: 50, LITERAL: 28, RETURN: 38,
    IMPORT_BINDING: 42, EXPORT_BINDING: 48,
    ASSIGNMENT: 33, BINARY_EXPRESSION: 30,
    MEMBER_EXPRESSION: 32, OBJECT: 36,
    ARRAY: 34, TEMPLATE_LITERAL: 30,
    DEFAULT: 35,
};

// Edge type colors — data flow (warm/cyan) vs control flow (magenta/orange) vs structure (blue/grey)
export const EDGE_COLORS = {
    // ── Data flow (cyan → green spectrum) ─────────────────
    READS_FROM:       0x00e5ff,  // bright cyan — primary data read
    ASSIGNED_FROM:    0x00bcd4,  // teal — value assignment
    WRITES_TO:        0xffe66d,  // yellow — mutation
    PASSES_ARGUMENT:  0x26c6da,  // light teal — argument passing
    RETURNS:          0x4dd0e1,  // pale cyan — return value
    ITERATES_OVER:    0x80deea,  // soft cyan — iteration
    DERIVES_FROM:     0x009688,  // dark teal — derivation
    RECEIVES_ARGUMENT:0x4db6ac,  // muted teal

    // ── Call graph (warm red/orange spectrum) ─────────────
    CALLS:            0xff5252,  // bright red — function call
    IMPORTS_FROM:     0xff7043,  // deep orange — cross-file import
    RESOLVES_TO:      0xff8a65,  // soft orange — name resolution
    DEPENDS_ON:       0xffab91,  // pale orange — module dependency
    RE_EXPORTS:       0xffccbc,  // very pale orange

    // ── Control flow (magenta/pink spectrum) ─────────────
    HAS_CONDITION:    0xe040fb,  // magenta — branch condition
    HAS_ALTERNATE:    0xce93d8,  // light purple — else branch
    HAS_CONSEQUENT:   0xba68c8,  // purple — then branch
    THROWS:           0xff1744,  // hot red — exception
    AWAITS:           0xea80fc,  // light magenta — async
    YIELDS:           0xb388ff,  // lavender — generator

    // ── Structure (blue/grey spectrum) ───────────────────
    CONTAINS:         0x1a237e,  // very dark blue — nearly invisible (structural noise)
    HAS_SCOPE:        0x1a237e,  // same — structural
    DECLARES:         0x283593,  // dark blue
    EXPORTS:          0x42a5f5,  // blue — export link
    HAS_METHOD:       0x5c6bc0,  // indigo
    HAS_FIELD:        0x7986cb,  // light indigo
    HAS_PROPERTY:     0x7986cb,  // same
    HAS_SIGNATURE:    0x9fa8da,  // pale indigo

    // ── Misc ─────────────────────────────────────────────
    OBSERVES:         0x78909c,  // blue grey — metrics
    HAS_ELEMENT:      0x546e7a,  // dark grey-blue
    HAS_BODY:         0x455a64,  // darker
    HAS_CATCH:        0xef5350,  // red — error handling
    HAS_FINALLY:      0xef9a9a,  // light red
    MISSING_CONSTRUCTOR: 0xff1744, // hot red — diagnostic

    DEFAULT:          0x37474f,  // dark blue-grey — fallback
};

// Hex geometry
export const HEX_ANGLES = [0, 60, 120, 180, 240, 300].map(a => a * Math.PI / 180);

// Pin marker
export const PIN_COLOR = 0xff2222;
export const PIN_HEIGHT = 2.5;
export const PIN_BOB_SPEED = 2.0;
export const PIN_BOB_AMPLITUDE = 0.5;

// Max rendered edges
export const MAX_EDGES_DEFAULT = 5000;
export const MAX_PINS = 200;
