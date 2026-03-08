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

// Edge type colors (as hex integers)
export const EDGE_COLORS = {
    CALLS: 0xff6b6b, READS_FROM: 0x4ecdc4, WRITES_TO: 0xffe66d,
    RETURNS: 0xa8e6cf, INHERITS: 0xdda0dd, IMPLEMENTS: 0xb0e0e6,
    IMPORTS: 0x87ceeb, EXPORTS: 0xffa07a, TYPE_OF: 0xd8bfd8,
    ARGUMENT_OF: 0xf0e68c, CONDITION_OF: 0xffb6c1,
    DEFAULT: 0x666666,
};

// Hex geometry
export const HEX_ANGLES = [0, 60, 120, 180, 240, 300].map(a => a * Math.PI / 180);

// Pin marker
export const PIN_COLOR = 0xff2222;
export const PIN_HEIGHT = 6.0;
export const PIN_BOB_SPEED = 2.0;
export const PIN_BOB_AMPLITUDE = 0.5;

// Max rendered edges
export const MAX_EDGES_DEFAULT = 5000;
export const MAX_PINS = 200;
