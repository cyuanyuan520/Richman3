"""Procedurally build the modern-city asset kit, characters and portraits.

Runs *inside* Blender (headless):

    blender --background --factory-startup -noaudio --python-exit-code 1 \
      --python scripts/build_assets.py -- \
      --config assets.config.json --out public/models --seed 20260925

Everything is generated from the config plus the shipped theme tokens, so the
same command on the same Blender build produces the same structural content.
Outputs are GLB meshes (plus PNG portraits) and an `assets.manifest.json`
recording what was produced for the renderer to consume.

The script is deliberately data-driven: `RECIPES` maps each declared asset key
to a list of primitive parts, and `build_asset` turns a recipe into geometry.
Adding a building is adding a table entry, not code.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any, Iterable, Sequence

import bpy
from mathutils import Vector

# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    own = list(argv[argv.index('--') + 1 :]) if '--' in argv else []
    parser = argparse.ArgumentParser(prog='build_assets.py')
    parser.add_argument('--config', required=True, help='path to the build config JSON')
    parser.add_argument('--out', required=True, help='output directory for GLB files')
    parser.add_argument('--seed', type=int, required=True, help='deterministic seed')
    parser.add_argument('--only', default=None, help='comma separated asset keys (debug)')
    return parser.parse_args(own)


# --------------------------------------------------------------------------- #
# Scene helpers
# --------------------------------------------------------------------------- #


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0


def material_for(name: str, palette: dict[str, str], roughness: float = 0.65) -> Any:
    """Get or create the material for a palette key.

    Materials cannot be cached across assets: every asset starts from an empty
    scene, which purges the datablocks and would leave dangling references.
    """
    existing = bpy.data.materials.get(name)
    if existing is not None:
        return existing
    if name not in palette:
        raise KeyError(f'palette has no colour named {name}')
    material = bpy.data.materials.new(name)
    node_tree = material.node_tree
    if node_tree is None:
        material.use_nodes = True
        node_tree = material.node_tree
    bsdf = node_tree.nodes['Principled BSDF']
    red, green, blue = hex_to_rgb(palette[name])
    bsdf.inputs['Base Color'].default_value = (red, green, blue, 1.0)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = 0.0
    return material


def srgb_to_linear(channel: float) -> float:
    """Convert one 0..1 sRGB channel to the scene-linear value Blender expects.

    Theme tokens are authored as sRGB hex because the UI consumes them directly.
    Feeding the raw sRGB value into `Base Color` would double-encode it: the
    exporter writes the socket as linear `baseColorFactor`, so the model would
    render visibly brighter and less saturated than the matching UI swatch.
    """
    if channel <= 0.04045:
        return channel / 12.92
    return ((channel + 0.055) / 1.055) ** 2.4


def hex_to_rgb(value: str) -> tuple[float, float, float]:
    text = value.lstrip('#')
    if len(text) != 6:
        raise ValueError(f'not a hex colour: {value}')
    return tuple(  # type: ignore[return-value]
        srgb_to_linear(int(text[index : index + 2], 16) / 255.0) for index in (0, 2, 4)
    )


# --------------------------------------------------------------------------- #
# Primitive parts
# --------------------------------------------------------------------------- #


def box(
    size: tuple[float, float, float],
    at: tuple[float, float, float] = (0.0, 0.0, 0.0),
    colour: str = 'ringBase',
    turn: float = 0.0,
) -> dict[str, Any]:
    return {'kind': 'box', 'size': size, 'at': at, 'colour': colour, 'turn': turn}


def cylinder(
    radius: float,
    depth: float,
    at: tuple[float, float, float] = (0.0, 0.0, 0.0),
    colour: str = 'ringBase',
    sides: int = 16,
) -> dict[str, Any]:
    return {
        'kind': 'cylinder',
        'radius': radius,
        'depth': depth,
        'at': at,
        'colour': colour,
        'sides': sides,
    }


def cone(
    radius: float,
    depth: float,
    at: tuple[float, float, float] = (0.0, 0.0, 0.0),
    colour: str = 'accentPrimary',
    sides: int = 12,
) -> dict[str, Any]:
    return {'kind': 'cone', 'radius': radius, 'depth': depth, 'at': at, 'colour': colour, 'sides': sides}


def sphere(
    radius: float,
    at: tuple[float, float, float] = (0.0, 0.0, 0.0),
    colour: str = 'accentPrimary',
) -> dict[str, Any]:
    return {'kind': 'sphere', 'radius': radius, 'at': at, 'colour': colour}


def lathe(
    profile: Sequence[tuple[float, float]],
    at: tuple[float, float, float] = (0.0, 0.0, 0.0),
    colour: str = 'ringBase',
    sides: int = 16,
    smooth: bool = True,
    cap_bottom: bool = True,
    cap_top: bool = True,
    turn: float = 0.0,
    tilt: tuple[float, float] = (0.0, 0.0),
) -> dict[str, Any]:
    """Solid of revolution around Z. `profile` is [(radius, height), ...] upward.

    A profile point with radius 0 becomes a pole, which is how domes, hats,
    skirts, gowns and rounded limbs are built without a sphere primitive.
    """
    return {
        'kind': 'lathe',
        'profile': tuple((float(radius), float(z)) for radius, z in profile),
        'at': at,
        'colour': colour,
        'sides': sides,
        'smooth': smooth,
        'cap_bottom': cap_bottom,
        'cap_top': cap_top,
        'turn': turn,
        'tilt': tilt,
    }


def frustum(
    radius: float,
    radius_top: float,
    height: float,
    at: tuple[float, float, float] = (0.0, 0.0, 0.0),
    colour: str = 'ringBase',
    sides: int = 16,
    smooth: bool = True,
    turn: float = 0.0,
    tilt: tuple[float, float] = (0.0, 0.0),
) -> dict[str, Any]:
    """A tapered tube: waists, skirts, crowns, sleeves, boots."""
    return lathe(
        [(radius, 0.0), (radius_top, height)],
        at=at,
        colour=colour,
        sides=sides,
        smooth=smooth,
        turn=turn,
        tilt=tilt,
    )


def capsule(
    radius: float,
    length: float,
    at: tuple[float, float, float] = (0.0, 0.0, 0.0),
    colour: str = 'uiPanel',
    sides: int = 12,
    down: bool = False,
    smooth: bool = True,
    turn: float = 0.0,
    tilt: tuple[float, float] = (0.0, 0.0),
) -> dict[str, Any]:
    """A rounded rod standing on `at`, or hanging below it with `down=True`."""
    return {
        'kind': 'capsule',
        'radius': radius,
        'length': length,
        'at': at,
        'colour': colour,
        'sides': sides,
        'down': down,
        'smooth': smooth,
        'turn': turn,
        'tilt': tilt,
    }


def ellipsoid(
    radius: float | tuple[float, float, float],
    at: tuple[float, float, float] = (0.0, 0.0, 0.0),
    colour: str = 'uiPanel',
    segments: int = 16,
    rings: int = 8,
    smooth: bool = True,
    turn: float = 0.0,
    tilt: tuple[float, float] = (0.0, 0.0),
) -> dict[str, Any]:
    """A squashed sphere: heads, chests, hands, buns, shoes, noses."""
    if isinstance(radius, (int, float)):
        radii = (float(radius), float(radius), float(radius))
    else:
        radii = (float(radius[0]), float(radius[1]), float(radius[2]))
    return {
        'kind': 'ellipsoid',
        'radius': radii,
        'at': at,
        'colour': colour,
        'segments': segments,
        'rings': rings,
        'smooth': smooth,
        'turn': turn,
        'tilt': tilt,
    }


def prism(
    points: Sequence[tuple[float, float]],
    extent: float,
    at: tuple[float, float, float] = (0.0, 0.0, 0.0),
    colour: str = 'ringBase',
    axis: str = 'z',
    turn: float = 0.0,
    tilt: tuple[float, float] = (0.0, 0.0),
    smooth: bool = False,
) -> dict[str, Any]:
    """Extrude a convex silhouette. Convex profiles only: the caps are fans.

    axis='z' takes (x, y) points and stands them on `at`; axis='y' takes (x, z)
    points and centres the extrusion on `at.y`. Gable roofs use axis='y'.
    """
    return {
        'kind': 'prism',
        'points': tuple((float(a), float(b)) for a, b in points),
        'extent': float(extent),
        'at': at,
        'colour': colour,
        'axis': axis,
        'turn': turn,
        'tilt': tilt,
        'smooth': smooth,
    }


def roof(
    width: float,
    depth: float,
    height: float,
    at: tuple[float, float, float] = (0.0, 0.0, 0.0),
    colour: str = 'groupRed',
    overhang: float = 0.0,
    turn: float = 0.0,
) -> dict[str, Any]:
    """A gable roof: ridge along Y, sloping in X, eaves at `at.z`."""
    half = (width + 2.0 * overhang) / 2.0
    return prism(
        [(-half, 0.0), (half, 0.0), (0.0, height)],
        depth + 2.0 * overhang,
        at=at,
        colour=colour,
        axis='y',
        turn=turn,
    )


# --------------------------------------------------------------------------- #
# Motifs
# --------------------------------------------------------------------------- #

# The tile deck top. Every prop stands on this, and nothing is allowed to sit
# flush against another surface: coplanar faces z-fight into flickering bands.
DECK = 0.22
EPS = 0.004

BASE = [
    box((1.94, 1.94, 0.19), (0.0, 0.0, 0.105), 'asphalt'),
    box((1.80, 1.80, 0.03), (0.0, 0.0, 0.205), 'deck'),
    box((2.02, 0.09, 0.07), (0.0, -0.965, 0.195), 'stone'),
    box((2.02, 0.09, 0.07), (0.0, 0.965, 0.195), 'stone'),
    box((0.09, 2.02, 0.07), (-0.965, 0.0, 0.195), 'stone'),
    box((0.09, 2.02, 0.07), (0.965, 0.0, 0.195), 'stone'),
]


def group_band(colour: str, width: float = 1.28) -> list[dict[str, Any]]:
    """The owning group's colour, painted across the deck."""
    return [box((width, width, 0.012), (0.0, 0.0, 0.226), colour)]


def cylinders_tree(radius: float, x: float, y: float = 0.0) -> list[dict[str, Any]]:
    return [
        cylinder(0.055, 0.46, (x, y, DECK + 0.23), 'woodDark', 8),
        ellipsoid((radius, radius, radius * 1.05), (x, y, DECK + 0.40), 'leaf', segments=14, rings=9),
        ellipsoid((radius * 0.62, radius * 0.62, radius * 0.66), (x + radius * 0.5, y - radius * 0.4,
                   DECK + 0.58), 'leaf', segments=12, rings=7),
    ]


def slab_at(
    width: float,
    depth: float,
    height: float,
    colour: str,
    x: float = 0.0,
    y: float = 0.0,
    base: float = DECK,
) -> dict[str, Any]:
    return box((width, depth, height), (x, y, base + height / 2), colour)


def slab(width: float, depth: float, height: float, colour: str, x: float = 0.0, y: float = 0.0) -> dict[str, Any]:
    return slab_at(width, depth, height, colour, x, y)


def panes(
    width: float,
    depth: float,
    z: float,
    height: float,
    colour: str = 'glass',
    *,
    thick: float = 0.05,
    span: float = 0.74,
    pitch: float = 0.34,
) -> list[dict[str, Any]]:
    """Window panes on all four walls of a footprint centred on the origin.

    Panes are centred on the wall plane, so half of each box is buried and the
    other half stands proud of the render wall: no coplanar faces, no z-fight.
    """
    parts: list[dict[str, Any]] = []
    columns_x = max(1, int(round(width / pitch)))
    columns_y = max(1, int(round(depth / pitch)))
    for column in range(columns_x):
        step = width * span / columns_x
        offset = (column - (columns_x - 1) / 2.0) * step
        parts.append(box((step * 0.68, thick, height), (offset, -depth / 2, z), colour))
        parts.append(box((step * 0.68, thick, height), (offset, depth / 2, z), colour))
    for column in range(columns_y):
        step = depth * span / columns_y
        offset = (column - (columns_y - 1) / 2.0) * step
        parts.append(box((thick, step * 0.68, height), (-width / 2, offset, z), colour))
        parts.append(box((thick, step * 0.68, height), (width / 2, offset, z), colour))
    return parts


def door(width: float, depth: float, colour: str = 'woodDark', cap: str = 'accentPrimary') -> list[dict[str, Any]]:
    """An entrance on the -Y wall with a canopy over it."""
    return [
        slab_at(width * 0.34, 0.06, 0.30, colour, 0.0, -depth / 2 - 0.01, DECK),
        slab_at(width * 0.52, 0.26, 0.05, cap, 0.0, -depth / 2 - 0.11, DECK + 0.31),
        box((0.05, 0.05, 0.24), (-width * 0.11, -depth / 2 - 0.10, DECK + 0.14), 'metal'),
        box((0.05, 0.05, 0.24), (width * 0.11, -depth / 2 - 0.10, DECK + 0.14), 'metal'),
    ]


def tower(
    width: float,
    depth: float,
    height: float,
    colour: str,
    cap: str = 'accentPrimary',
    levels: int = 2,
    x: float = 0.0,
    y: float = 0.0,
    pane: str = 'glass',
    lit: str | None = 'glassLit',
) -> list[dict[str, Any]]:
    """A block with a podium, a lit window grid per floor, and a cornice."""
    floors = max(1, levels)
    floor_height = height / floors
    window_height = min(floor_height * 0.48, 0.34)
    top = DECK + height
    parts: list[dict[str, Any]] = [
        slab(width, depth, height, colour, x, y),
        slab_at(width * 1.18, depth * 1.18, 0.10 + EPS, 'stone', x, y, DECK - EPS),
        slab_at(width * 1.12, depth * 1.12, 0.05, 'trim', x, y, DECK + 0.10),
        slab_at(width * 1.12, depth * 1.12, 0.09, 'trim', x, y, top - 0.07),
        slab_at(width * 0.90, depth * 0.90, 0.07, cap, x, y, top + 0.02),
        slab_at(width * 0.34, depth * 0.34, 0.16, 'metal', x + width * 0.24, y - depth * 0.24, top + 0.09),
    ]
    for floor in range(floors):
        centre = DECK + floor_height * (floor + 0.5)
        for part in panes(width, depth, centre, window_height, pane):
            px, py, pz = part['at']
            parts.append(box(part['size'], (px + x, py + y, pz), part['colour']))
        if lit is not None and floor % 3 == 1:
            step = width * 0.74 / max(1, int(round(width / 0.34)))
            parts.append(box((step * 0.68, 0.06, window_height), (x, y - depth / 2, centre), lit))
    parts.extend(door(width, depth, cap=cap))
    return parts


def house(level: int) -> list[dict[str, Any]]:
    """The four upgrade levels of an owned property, smallest to largest."""
    width = 0.60 + 0.13 * level
    height = 0.28 + 0.25 * level
    colour = ['groupBlue', 'groupYellow', 'groupRed', 'groupGold'][level - 1]
    top = DECK + height
    parts: list[dict[str, Any]] = [
        slab(width, width, height, colour),
        box((width * 1.14, width * 1.14, 0.07), (0.0, 0.0, top - 0.02), 'trim'),
    ]
    parts.extend(panes(width, width, DECK + height * 0.62, min(0.20, height * 0.38), 'glass'))
    parts.extend(door(width, width, cap=colour))
    parts.append(roof(width * 1.24, width * 1.24, 0.15 + 0.045 * level, (0.0, 0.0, top), 'roofTile', overhang=0.035))
    parts.append(box((0.06, 0.06, 0.20), (width * 0.26, width * 0.26, top + 0.16), 'stone'))
    if level >= 2:
        parts.append(slab_at(width * 0.44, width * 0.44, height * 0.54, colour, width * 0.36, width * 0.36))
        parts.append(
            roof(
                width * 0.56,
                width * 0.56,
                0.16 + 0.05 * level,
                (width * 0.36, width * 0.36, DECK + height * 0.54),
                'roofSlate',
                overhang=0.03,
            )
        )
    if level >= 3:
        parts.append(slab_at(width * 0.36, width * 0.36, height * 0.86, colour, -width * 0.40, width * 0.34))
        parts.append(
            roof(
                width * 0.46,
                width * 0.46,
                0.15 + 0.05 * level,
                (-width * 0.40, width * 0.34, DECK + height * 0.86),
                'roofSlate',
                overhang=0.03,
            )
        )
    if level >= 4:
        parts.append(cylinder(0.055, 0.34, (0.0, 0.0, top + 0.42), 'accentSecondary', 10))
        parts.append(cone(0.10, 0.16, (0.0, 0.0, top + 0.66), 'accentPrimary', 12))
    return parts


def dice() -> list[dict[str, Any]]:
    parts = [box((0.7, 0.7, 0.7), (0.0, 0.0, 0.55), 'uiPanel')]
    pips = [(0.0, 0.0), (0.18, 0.18), (-0.18, 0.18), (0.18, -0.18), (-0.18, -0.18)]
    for x, y in pips:
        parts.append(cylinder(0.055, 0.06, (x, y, 0.91), 'uiText', 8))
    parts.append(cylinder(0.055, 0.06, (0.0, 0.36, 0.55), 'uiText', 8))
    return parts


# --------------------------------------------------------------------------- #
# Characters
# --------------------------------------------------------------------------- #
#
# Every figure shares one skeleton so the four read as the same toy line, and
# each archetype then dresses it. Heights are authored from the soles upward and
# lifted onto the board at the end: the pawn anchor sits 0.06 above the tile and
# the tile deck is 0.22 high, so the soles belong at 0.16.
#
# In the skeleton:
#   sole 0.000   knee 0.284   hip 0.496   waist 0.588
#   chest 0.737  shoulder 0.775   chin 0.885   crown 1.195

GROUND = 0.16

SKIN = 'skin'
SKIN_SHADE = 'skinShade'
DARK = 'uiText'


def _lift(parts: list[dict[str, Any]], ground: float = GROUND) -> list[dict[str, Any]]:
    """Drop an authored-at-origin figure onto the board."""
    lifted: list[dict[str, Any]] = []
    for part in parts:
        moved = dict(part)
        x, y, z = part['at']
        moved['at'] = (x, y, z + ground)
        lifted.append(moved)
    return lifted


def _pair(build: Any) -> list[dict[str, Any]]:
    """Mirror a per-side builder across the body's midline."""
    return [*build(-1.0), *build(1.0)]


def _face(skin: str, *, brow: str = 'hairDark', blush: str | None = None, mouth: bool = True) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []

    def eye(side: float) -> list[dict[str, Any]]:
        x = side * 0.058
        return [
            ellipsoid((0.042, 0.028, 0.048), (x, -0.120, 1.024), 'uiPanel', segments=12, rings=6),
            ellipsoid((0.025, 0.021, 0.029), (x, -0.132, 1.042), DARK, segments=10, rings=5),
            ellipsoid((0.009, 0.008, 0.010), (x - 0.009, -0.147, 1.054), 'uiPanel', segments=8, rings=4),
        ]

    def ear(side: float) -> list[dict[str, Any]]:
        return [ellipsoid((0.018, 0.036, 0.040), (side * 0.138, 0.0, 1.006), skin, segments=10, rings=5)]

    parts.extend(_pair(eye))
    parts.extend(_pair(ear))
    parts.append(ellipsoid((0.018, 0.021, 0.016), (0.0, -0.138, 1.030), skin, segments=10, rings=5))
    if mouth:
        parts.append(ellipsoid((0.026, 0.010, 0.010), (0.0, -0.134, 0.994), 'lips', segments=10, rings=5))
    if blush is not None:
        parts.extend(
            _pair(
                lambda side: [
                    ellipsoid((0.020, 0.012, 0.014), (side * 0.100, -0.108, 0.990), blush, segments=10, rings=5)
                ]
            )
        )
    parts.extend(
        _pair(
            lambda side: [
                box((0.060, 0.016, 0.012), (side * 0.058, -0.132, 1.104), brow, turn=side * -0.13)
            ]
        )
    )
    return parts


def _legs(skin: str, upper: str, lower: str, shoe: str, *, boot: str | None = None) -> list[dict[str, Any]]:
    if boot is None:
        return _pair(
            lambda side: [
                ellipsoid((0.060, 0.084, 0.034), (side * 0.070, -0.020, 0.0), shoe, segments=14, rings=8),
                frustum(0.040, 0.047, 0.246, (side * 0.070, 0.0, 0.044), lower, sides=12),
                frustum(0.050, 0.061, 0.232, (side * 0.070, 0.0, 0.264), upper, sides=12),
            ]
        )
    return _pair(
        lambda side: [
            ellipsoid((0.064, 0.090, 0.036), (side * 0.070, -0.022, 0.0), shoe, segments=14, rings=8),
            frustum(0.040, 0.047, 0.246, (side * 0.070, 0.0, 0.044), lower, sides=12),
            frustum(0.050, 0.061, 0.232, (side * 0.070, 0.0, 0.264), upper, sides=12),
            frustum(0.070, 0.058, 0.070, (side * 0.070, 0.0, 0.070), boot, sides=12),
        ]
    )


def _torso(skin: str, shirt: str, hips: str) -> list[dict[str, Any]]:
    return [
        frustum(0.138, 0.128, 0.110, (0.0, 0.0, 0.480), hips, sides=14),
        frustum(0.126, 0.150, 0.155, (0.0, 0.0, 0.582), shirt, sides=14),
        ellipsoid((0.160, 0.100, 0.056), (0.0, 0.0, 0.712), shirt, segments=16, rings=8),
        cylinder(0.050, 0.080, (0.0, 0.0, 0.850), skin, 12),
        ellipsoid((0.148, 0.158, 0.155), (0.0, 0.0, 0.885), skin, segments=18, rings=10),
    ]


def _arms(
    sleeve: str,
    hand: str,
    *,
    forearm: str | None = None,
    spread: float = 0.30,
    forward: float = 0.08,
    cuff: str | None = None,
) -> list[dict[str, Any]]:
    """Hanging arms: an upper arm angled out, a forearm angled less, a hand."""

    def arm(side: float) -> list[dict[str, Any]]:
        shoulder = (side * 0.130, 0.0, 0.775)
        upper_tilt = (forward * -1.0, -side * spread)
        upper = 0.160
        elbow = joint(shoulder, -upper, 0.0, upper_tilt)
        fore_tilt = (forward * -1.6, -side * spread * 0.30)
        return [
            ellipsoid((0.066, 0.066, 0.062), (side * 0.124, 0.0, 0.712), sleeve, segments=12, rings=7),
            capsule(0.043, upper, shoulder, sleeve, sides=10, down=True, tilt=upper_tilt),
            capsule(0.038, 0.150, elbow, forearm or sleeve, sides=10, down=True, tilt=fore_tilt),
            ellipsoid((0.046, 0.040, 0.050), (elbow[0] + side * 0.012, elbow[1] - 0.012, elbow[2] - 0.170), hand,
                      segments=12, rings=6),
            *(
                [frustum(0.044, 0.040, 0.055, (elbow[0], elbow[1], elbow[2] - 0.155), cuff, sides=10)]
                if cuff
                else []
            ),
        ]

    return _pair(arm)


def _boots(skin: str, colour: str) -> list[dict[str, Any]]:
    return _pair(
        lambda side: [
            frustum(0.058, 0.050, 0.150, (side * 0.070, 0.0, 0.030), colour, sides=10),
        ]
    )


def _hat_straw(accent: str, band: str) -> list[dict[str, Any]]:
    return [
        lathe(
            [(0.0, 0.0), (0.300, 0.008), (0.316, 0.042), (0.170, 0.070), (0.164, 0.210), (0.0, 0.246)],
            (0.0, 0.0, 1.128),
            accent,
            sides=18,
            cap_bottom=False,
        ),
        frustum(0.168, 0.166, 0.038, (0.0, 0.0, 1.148), band, sides=18),
    ]


def _hair_cap(colour: str, *, base: float = 1.052, radius: float = 0.161) -> list[dict[str, Any]]:
    """A shell over the top of the skull only.

    Starting this above the brows is what keeps the face readable; the back of
    the head is covered separately by a mass offset behind the face.
    """
    return [
        lathe(
            [
                (radius * 0.98, 0.0),
                (radius, 0.048),
                (radius * 0.88, 0.132),
                (radius * 0.44, 0.182),
                (0.0, 0.202),
            ],
            (0.0, 0.0, base),
            colour,
            sides=18,
            cap_bottom=False,
        )
    ]


def _bun(colour: str, x: float, z: float, radius: float) -> list[dict[str, Any]]:
    return [ellipsoid((radius, radius, radius * 0.86), (x, 0.012, z), colour, segments=14, rings=8)]


def _character_farmer() -> list[dict[str, Any]]:
    shirt = 'player_farmer'
    denim = 'denim'
    parts: list[dict[str, Any]] = []
    parts.extend(_legs(SKIN, denim, denim, 'woodDark', boot='woodDark'))
    parts.extend(_torso(SKIN, shirt, denim))
    parts.extend(_arms(shirt, SKIN, forearm=SKIN, spread=0.34))
    parts.extend(_face(SKIN, brow='hairDark'))
    # straw hair poking out under the brim, then the hat itself
    parts.extend(
        [
            ellipsoid((0.150, 0.160, 0.110), (0.0, 0.018, 0.905), 'hairDark', segments=16, rings=8),
            *_hat_straw('accentSecondary', 'groupRed'),
        ]
    )
    # overall bib, straps and a neckerchief
    parts.extend(
        [
            box((0.150, 0.030, 0.150), (0.0, -0.126, 0.640), denim),
            box((0.150, 0.030, 0.052), (0.0, -0.124, 0.726), denim),
            box((0.030, 0.030, 0.030), (0.0, -0.142, 0.690), 'accentSecondary'),
            box((0.038, 0.016, 0.150), (0.055, -0.118, 0.760), denim, turn=0.16),
            box((0.038, 0.016, 0.150), (-0.055, -0.118, 0.760), denim, turn=-0.16),
            box((0.046, 0.110, 0.026), (0.058, -0.020, 0.792), denim),
            box((0.046, 0.110, 0.026), (-0.058, -0.020, 0.792), denim),
            frustum(0.088, 0.116, 0.052, (0.0, 0.0, 0.836), 'groupRed', sides=14),
        ]
    )
    # a wheat sheaf resting against the shoulder
    parts.extend(
        [
            cylinder(0.012, 0.240, (0.176, 0.052, 0.660), 'accentSecondary', 6),
            cone(0.030, 0.090, (0.176, 0.052, 0.800), 'leaf', 8),
        ]
    )
    return _lift(parts)


def _character_girl() -> list[dict[str, Any]]:
    dress = 'player_girl'
    blouse = 'uiPanel'
    hair = 'hairWarm'
    parts: list[dict[str, Any]] = []
    # legs below the hem, with knee socks
    parts.extend(_legs(SKIN, SKIN, 'uiPanel', 'accentPrimary'))
    parts.append(
        lathe(
            [(0.204, 0.0), (0.188, 0.140), (0.164, 0.262), (0.152, 0.302)],
            (0.0, 0.0, 0.316),
            dress,
            sides=20,
            cap_bottom=True,
        )
    )
    parts.append(frustum(0.132, 0.150, 0.155, (0.0, 0.0, 0.598), blouse, sides=14))
    parts.append(frustum(0.150, 0.156, 0.060, (0.0, 0.0, 0.752), dress, sides=14))
    parts.extend(_torso_upper_only(blouse))
    parts.extend(_arms(blouse, SKIN, spread=0.34, cuff='uiPanel'))
    parts.extend(_face(SKIN, brow='hairWarm', blush='player_girl'))
    # hair: cap, long back mass, fringe, twin buns with ribbons
    parts.extend(_hair_cap(hair))
    parts.extend(
        [
            ellipsoid((0.152, 0.140, 0.150), (0.0, 0.040, 0.870), hair, segments=16, rings=9),
            ellipsoid((0.050, 0.040, 0.120), (0.132, 0.030, 0.900), hair, segments=12, rings=6),
            ellipsoid((0.050, 0.040, 0.120), (-0.132, 0.030, 0.900), hair, segments=12, rings=6),
            ellipsoid((0.100, 0.070, 0.070), (0.0, -0.118, 1.128), hair, segments=14, rings=7),
            *_bun(hair, 0.138, 1.108, 0.058),
            *_bun(hair, -0.138, 1.108, 0.058),
            box((0.062, 0.020, 0.016), (0.140, 0.040, 1.112), 'accentPrimary', turn=0.34),
            box((0.062, 0.020, 0.016), (-0.140, 0.040, 1.112), 'accentPrimary', turn=-0.34),
            ellipsoid((0.024, 0.019, 0.024), (0.150, 0.024, 1.152), 'accentPrimary', segments=10, rings=5),
            ellipsoid((0.024, 0.019, 0.024), (-0.150, 0.024, 1.152), 'accentPrimary', segments=10, rings=5),
        ]
    )
    # a little satchel
    parts.extend(
        [
            box((0.090, 0.048, 0.080), (0.150, 0.036, 0.640), 'accentSecondary', turn=0.18),
            box((0.020, 0.020, 0.030), (0.146, 0.010, 0.690), 'woodDark'),
        ]
    )
    return _lift(parts)


def _torso_upper_only(shirt: str) -> list[dict[str, Any]]:
    return [
        ellipsoid((0.152, 0.098, 0.054), (0.0, 0.0, 0.716), shirt, segments=16, rings=8),
        cylinder(0.048, 0.078, (0.0, 0.0, 0.850), SKIN, 12),
        ellipsoid((0.146, 0.156, 0.152), (0.0, 0.0, 0.886), SKIN, segments=18, rings=10),
    ]


def _character_madame() -> list[dict[str, Any]]:
    gown = 'player_madame'
    parts: list[dict[str, Any]] = []
    parts.append(
        lathe(
            [(0.222, 0.0), (0.196, 0.190), (0.168, 0.430), (0.152, 0.500)],
            (0.0, 0.0, 0.100),
            gown,
            sides=22,
            cap_bottom=True,
        )
    )
    parts.append(frustum(0.132, 0.150, 0.160, (0.0, 0.0, 0.578), gown, sides=14))
    parts.extend(_torso_upper_only(gown))
    # bare shoulders with long gloves
    parts.extend(_arms(gown, 'accentSecondary', forearm='accentSecondary', spread=0.26, forward=0.02))
    parts.extend(_face(SKIN, brow='hairDark'))
    # swept updo, back mass, earrings and a tiara
    parts.extend(_hair_cap('hairDark'))
    parts.extend(
        [
            ellipsoid((0.150, 0.132, 0.140), (0.0, 0.052, 0.880), 'hairDark', segments=16, rings=9),
            lathe(
                [(0.052, 0.0), (0.098, 0.052), (0.080, 0.120), (0.0, 0.150)],
                (0.0, 0.020, 1.190),
                'hairDark',
                sides=14,
            ),
            ellipsoid((0.022, 0.018, 0.030), (0.140, 0.004, 0.985), 'accentSecondary', segments=10, rings=5),
            ellipsoid((0.022, 0.018, 0.030), (-0.140, 0.004, 0.985), 'accentSecondary', segments=10, rings=5),
            lathe(
                [(0.104, 0.0), (0.108, 0.016), (0.086, 0.030)],
                (0.0, 0.010, 1.078),
                'accentSecondary',
                sides=16,
                cap_bottom=False,
            ),
            ellipsoid((0.020, 0.016, 0.022), (0.0, -0.104, 1.088), 'accentPrimary', segments=10, rings=5),
        ]
    )
    # stole, necklace and a folded fan
    parts.append(frustum(0.126, 0.150, 0.062, (0.0, 0.0, 0.804), 'trim', sides=16))
    parts.extend(
        [
            *(
                [
                    ellipsoid((0.014, 0.012, 0.014), (0.0, -0.118, 0.826), 'accentSecondary', segments=8, rings=4),
                    ellipsoid((0.013, 0.011, 0.013), (0.030, -0.112, 0.834), 'accentSecondary', segments=8, rings=4),
                    ellipsoid((0.013, 0.011, 0.013), (-0.030, -0.112, 0.834), 'accentSecondary', segments=8, rings=4),
                ]
            )
        ]
    )
    parts.extend(
        [
            prism(
                [(0.0, 0.0), (0.150, 0.0), (0.150, 0.020), (0.0, 0.150)],
                0.030,
                (0.196, -0.060, 0.430),
                'trim',
                axis='z',
                turn=-0.5,
            ),
            prism(
                [(0.0, 0.0), (0.130, 0.0), (0.130, 0.018), (0.0, 0.130)],
                0.024,
                (0.196, -0.052, 0.444),
                'accentPrimary',
                axis='z',
                turn=-0.5,
            ),
        ]
    )
    return _lift(parts)


def _character_ninja() -> list[dict[str, Any]]:
    suit = 'player_ninja'
    wrap = 'uiShadow'
    parts: list[dict[str, Any]] = []
    parts.extend(_legs(suit, suit, suit, 'woodDark'))
    parts.extend(_torso(suit, suit, suit))
    parts.extend(_arms(suit, DARK, forearm=wrap, spread=0.28, cuff=None))
    parts.extend(
        _pair(
            lambda side: [
                ellipsoid((0.046, 0.032, 0.036), (side * 0.060, -0.152, 1.042), 'uiPanel',
                          segments=12, rings=6),
                ellipsoid((0.027, 0.024, 0.028), (side * 0.062, -0.166, 1.048), DARK,
                          segments=10, rings=5),
            ]
        )
    )
    # hood over the whole skull with a gap for the eyes, plus a mask and headband
    parts.extend(
        [
            ellipsoid((0.166, 0.176, 0.170), (0.0, 0.008, 0.872), suit, segments=18, rings=10),
            box((0.208, 0.120, 0.104), (0.0, -0.100, 0.932), DARK),
            box((0.212, 0.034, 0.022), (0.0, -0.176, 1.086), DARK),
            frustum(0.100, 0.132, 0.060, (0.0, 0.004, 0.808), DARK, sides=16),
        ]
    )
    # headband with trailing tails
    parts.extend(
        [
            frustum(0.158, 0.156, 0.036, (0.0, 0.0, 1.082), 'groupRed', sides=18),
            prism(
                [(0.0, 0.0), (0.130, 0.030), (0.150, 0.180), (0.0, 0.120)],
                0.020,
                (0.130, 0.080, 1.076),
                'groupRed',
                axis='z',
                turn=0.4,
            ),
            prism(
                [(0.0, 0.0), (0.100, 0.020), (0.118, 0.150), (0.0, 0.100)],
                0.018,
                (0.126, 0.098, 1.062),
                'groupRed',
                axis='z',
                turn=0.9,
            ),
        ]
    )
    # sash with a knot and two hanging ends
    parts.extend(
        [
            frustum(0.134, 0.140, 0.048, (0.0, 0.0, 0.578), 'accentPrimary', sides=14),
            ellipsoid((0.040, 0.034, 0.036), (0.040, 0.118, 0.596), 'accentPrimary', segments=10, rings=5),
            prism(
                [(0.0, 0.0), (0.062, 0.014), (0.044, -0.170), (0.0, -0.150)],
                0.020,
                (0.046, 0.144, 0.612),
                'accentPrimary',
                axis='z',
                turn=0.2,
                tilt=(0.10, 0.0),
            ),
        ]
    )
    # shin wraps and a katana on the back
    parts.extend(
        _pair(
            lambda side: [
                frustum(0.048, 0.044, 0.130, (side * 0.070, 0.0, 0.180), wrap, sides=12),
            ]
        )
    )
    parts.extend(
        [
            prism(
                [(0.0, 0.0), (0.030, 0.020), (0.030, 0.026), (0.0, 0.520)],
                0.016,
                (0.0, 0.152, 0.560),
                'metal',
                axis='z',
                turn=0.0,
                tilt=(0.0, 0.62),
            ),
            cylinder(0.048, 0.026, (0.0, 0.152, 0.786), 'accentSecondary', 10),
            cylinder(0.020, 0.150, (0.0, 0.152, 0.902), DARK, 8),
        ]
    )
    return _lift(parts)


CHARACTER_BUILDERS = {
    'farmer': _character_farmer,
    'girl': _character_girl,
    'madame': _character_madame,
    'ninja': _character_ninja,
}


def character(archetype: str) -> list[dict[str, Any]]:
    return CHARACTER_BUILDERS[archetype]()


def RECIPES() -> dict[str, dict[str, Any]]:  # noqa: N802 - reads as a table
    table: dict[str, dict[str, Any]] = {}

    def add(key: str, parts: Iterable[dict[str, Any]], tags: Sequence[str], scale: float = 1.0) -> None:
        table[key] = {'parts': list(parts), 'tags': list(tags), 'scale': scale}

    # -- ring tiles -------------------------------------------------------- #
    add('city.road', BASE + [box((1.78, 1.78, 0.026), (0.0, 0.0, 0.233), 'road')], ['tile', 'ring-base'])
    add(
        'city.start_station',
        BASE + [slab(1.3, 1.3, 0.5, 'accentSecondary'), box((1.5, 1.5, 0.1), (0.0, 0.0, 0.75), 'accentPrimary')],
        ['tile', 'landmark'],
    )
    add(
        'city.shop_convenience',
        BASE + tower(1.2, 1.2, 0.9, 'groupBlue', 'accentPrimary', 1) + [box((1.4, 0.5, 0.14), (0.0, -0.85, 1.34), 'accentSecondary')],
        ['tile', 'building', 'group:blue'],
    )
    add(
        'city.shop_tea',
        BASE + tower(1.1, 1.1, 0.8, 'groupYellow', 'accentSecondary', 1) + [cone(0.9, 0.36, (0.0, 0.0, 1.28), 'accentPrimary', 12)],
        ['tile', 'building', 'group:yellow'],
    )
    add(
        'city.chance_billboard',
        BASE + [cylinder(0.12, 1.2, (0.0, 0.0, 0.8), 'uiText', 10), box((1.4, 0.14, 0.7), (0.0, 0.0, 1.6), 'accentSecondary')],
        ['tile', 'prop'],
    )
    add(
        'city.park',
        BASE
        + [
            *cylinders_tree(0.55, 0.0),
            *cylinders_tree(0.55, 1.1),
            box((1.2, 0.3, 0.06), (0.0, -0.5, 0.23), 'accentCool'),
        ],
        ['tile', 'prop'],
    )
    add(
        'city.hospital_pet',
        BASE + tower(1.15, 1.15, 0.85, 'uiPanel', 'groupRed', 2) + [box((0.5, 0.12, 0.12), (0.0, -0.62, 1.2), 'accentPrimary'), box((0.12, 0.12, 0.5), (0.0, -0.62, 1.2), 'accentPrimary')],
        ['tile', 'building'],
    )
    add(
        'city.tax_office',
        BASE + tower(1.2, 1.2, 1.0, 'uiShadow', 'accentPrimary', 2) + [cylinder(0.34, 0.4, (0.0, 0.0, 1.6), 'accentSecondary', 12)],
        ['tile', 'building', 'group:red'],
    )
    add(
        'city.wall_mural',
        BASE + [box((1.9, 0.16, 0.9), (0.0, -0.7, 0.75), 'groupRed'), box((1.4, 0.08, 0.3), (0.0, -0.62, 0.95), 'accentCool'), box((1.0, 0.08, 0.24), (0.0, -0.62, 0.55), 'accentSecondary')],
        ['tile', 'prop', 'group:red'],
    )
    add(
        'city.metro_entrance',
        BASE + [box((1.3, 1.3, 0.24), (0.0, 0.0, 0.32), 'uiText'), box((1.4, 0.3, 0.16), (0.0, -0.6, 0.55), 'accentCool'), cylinder(0.42, 0.5, (0.0, 0.0, 1.0), 'accentCool', 14)],
        ['tile', 'warp', 'landmark'],
    )
    add(
        'city.delivery_hub',
        BASE + tower(1.25, 1.25, 0.7, 'accentSecondary', 'accentPrimary', 1) + [box((0.5, 0.5, 0.4), (0.55, -0.6, 0.55), 'groupYellow')],
        ['tile', 'building', 'group:yellow'],
    )
    add(
        'city.bike_graveyard',
        BASE + [box((0.5, 0.06, 0.3), (-0.3, -0.3, 0.42), 'accentCool', 0.4), box((0.5, 0.06, 0.3), (0.2, 0.2, 0.42), 'accentPrimary', -0.5), box((0.5, 0.06, 0.3), (0.45, -0.35, 0.42), 'accentSecondary', 0.9)],
        ['tile', 'prop'],
    )
    add(
        'city.chaos_house',
        BASE + tower(1.15, 1.15, 0.95, 'uiShadow', 'accentPrimary', 2) + [cone(0.95, 0.55, (0.0, 0.0, 1.5), 'accentPrimary', 6), cylinder(0.08, 0.5, (0.0, 0.0, 1.95), 'uiText', 8)],
        ['tile', 'building', 'chaos'],
    )
    add(
        'city.office_tower',
        BASE + tower(1.0, 1.0, 1.7, 'accentCool', 'metal', 5),
        ['tile', 'building', 'group:blue'],
    )
    add(
        'city.studio',
        BASE + tower(1.2, 1.2, 1.1, 'groupRed', 'accentSecondary', 2) + [cylinder(0.2, 0.5, (0.6, 0.6, 1.55), 'accentPrimary', 10)],
        ['tile', 'building', 'group:red'],
    )
    add(
        'city.mall',
        BASE + tower(1.5, 1.3, 1.15, 'groupGold', 'accentPrimary', 3) + [box((1.7, 1.5, 0.12), (0.0, 0.0, 1.56), 'trim')],
        ['tile', 'building', 'group:gold'],
    )
    add(
        'city.hotel_luxe',
        BASE + tower(1.2, 1.2, 1.5, 'groupGold', 'accentSecondary', 3) + [sphere(0.22, (0.0, 0.0, 1.95), 'accentPrimary')],
        ['tile', 'building', 'group:gold'],
    )
    add(
        'city.jail',
        BASE + [slab(1.5, 1.4, 0.9, 'uiShadow'), cylinder(0.05, 0.9, (-0.5, -0.7, 0.65), 'uiText', 6), cylinder(0.05, 0.9, (-0.3, -0.7, 0.65), 'uiText', 6), cylinder(0.05, 0.9, (-0.1, -0.7, 0.65), 'uiText', 6), box((1.6, 1.5, 0.12), (0.0, 0.0, 1.15), 'uiText')],
        ['tile', 'building'],
    )
    add(
        'city.golf',
        BASE + [box((1.7, 1.7, 0.08), (0.0, 0.0, 0.24), 'ground'), cylinder(0.06, 0.9, (0.5, 0.5, 0.65), 'uiPanel', 6), cone(0.22, 0.3, (0.5, 0.5, 1.2), 'accentPrimary', 10)],
        ['tile', 'prop'],
    )
    add(
        'city.finance_center',
        BASE + tower(1.1, 1.1, 1.9, 'groupBlue', 'metal', 5),
        ['tile', 'building', 'group:blue'],
    )
    add(
        'city.bonus_chest',
        BASE + [box((0.9, 0.7, 0.6), (0.0, 0.0, 0.5), 'groupGold'), box((0.96, 0.76, 0.14), (0.0, 0.0, 0.85), 'accentSecondary'), cylinder(0.12, 0.2, (0.0, 0.0, 0.6), 'accentPrimary', 10)],
        ['tile', 'bonus'],
    )
    add(
        'city.skyscraper',
        BASE + tower(0.95, 0.95, 2.3, 'metal', 'accentCool', 6) + [cylinder(0.06, 0.7, (0.0, 0.0, 2.9), 'accentPrimary', 6)],
        ['tile', 'building', 'group:gold'],
    )
    add(
        'city.tax_bureau',
        BASE + tower(1.25, 1.25, 0.95, 'uiShadow', 'accentPrimary', 2) + [box((1.4, 0.2, 0.2), (0.0, -0.7, 1.2), 'accentSecondary')],
        ['tile', 'building', 'group:red'],
    )
    add(
        'city.apartment_old',
        BASE + tower(1.15, 1.15, 1.3, 'uiShadow', 'accentSecondary', 3) + [box((0.3, 0.3, 0.3), (0.7, 0.7, 1.6), 'uiText')],
        ['tile', 'building', 'group:yellow'],
    )
    add(
        'city.lost_and_found',
        BASE + [slab(1.1, 1.1, 0.5, 'accentSecondary'), box((0.7, 0.5, 0.4), (0.0, 0.0, 0.95), 'groupBlue'), box((0.9, 0.5, 0.1), (0.0, 0.0, 1.2), 'uiPanel')],
        ['tile', 'building', 'group:blue'],
    )
    add(
        'city.underpass',
        BASE + [box((1.9, 0.3, 0.5), (0.0, -0.75, 0.45), 'uiShadow'), box((1.9, 0.3, 0.5), (0.0, 0.75, 0.45), 'uiShadow'), box((1.9, 1.8, 0.2), (0.0, 0.0, 0.85), 'road')],
        ['tile', 'warp'],
    )
    add(
        'city.event_plaza',
        BASE + [box((1.7, 1.7, 0.06), (0.0, 0.0, 0.23), 'uiPanel'), cylinder(0.14, 0.9, (0.0, 0.0, 0.7), 'accentCool', 12), sphere(0.26, (0.0, 0.0, 1.3), 'accentPrimary')],
        ['tile', 'landmark', 'event'],
    )
    add(
        'city.gacha_gate',
        BASE + [box((1.6, 0.24, 1.2), (0.0, -0.5, 0.8), 'accentPrimary'), box((1.6, 0.24, 1.2), (0.0, 0.5, 0.8), 'accentSecondary'), sphere(0.3, (0.0, 0.0, 1.35), 'accentCool')],
        ['tile', 'warp', 'landmark'],
    )
    add(
        'city.minigame_park',
        BASE + [box((1.6, 1.6, 0.06), (0.0, 0.0, 0.23), 'accentCool'), cylinder(0.9, 0.14, (0.0, 0.0, 0.5), 'accentSecondary', 16), cylinder(0.08, 1.0, (0.0, 0.0, 1.0), 'uiText', 8), box((0.9, 0.1, 0.5), (0.0, 0.0, 1.4), 'accentPrimary')],
        ['tile', 'landmark', 'minigame'],
    )
    add(
        'city.escalator',
        BASE + [box((1.8, 0.7, 0.8), (0.0, -0.5, 0.6), 'uiShadow'), box((1.8, 0.7, 0.5), (0.0, 0.5, 0.45), 'uiShadow'), box((1.4, 0.2, 0.3), (0.0, -0.9, 1.1), 'accentCool')],
        ['tile', 'warp'],
    )
    add(
        'city.express_lift',
        BASE + [box((0.9, 0.9, 2.0), (0.0, 0.0, 1.2), 'metal'), box((1.0, 1.0, 0.14), (0.0, 0.0, 2.25), 'accentCool'), box((0.7, 0.06, 0.9), (0.0, -0.47, 1.3), 'accentCool')],
        ['tile', 'warp'],
    )

    # -- property upgrade levels and the die ------------------------------- #
    for level in (1, 2, 3, 4):
        add(f'city.house_{level}', BASE + house(level), ['tile', 'house', f'level:{level}'])
    add('city.dice', dice(), ['prop', 'dice'])

    # -- characters -------------------------------------------------------- #
    for archetype in ('farmer', 'girl', 'madame', 'ninja'):
        add(f'char_{archetype}', character(archetype), ['character', f'archetype:{archetype}'])

    return table


# --------------------------------------------------------------------------- #
# Geometry
# --------------------------------------------------------------------------- #

# Parts are turned into vertices and faces here rather than through `bpy.ops`
# primitives. The operators are convenient, but their output is not byte-stable
# across runs (the UV sphere in particular), which makes committed artefacts
# churn on every rebuild. Generating the geometry explicitly keeps the pipeline
# reproducible: the same config and the same code give the same bytes.


def place(
    point: tuple[float, float, float],
    origin: tuple[float, float, float],
    turn: float,
    tilt: tuple[float, float] = (0.0, 0.0),
) -> tuple[float, float, float]:
    """Move a point given relative to the part origin into asset space.

    `turn` spins about Z (yaw). `tilt` is (pitch about X, roll about Y) applied
    first, which is what lets a base-anchored limb hinge at its origin: a shin
    authored hanging down from the hip can swing forward and outward.
    Negative pitch swings toward -Y, the direction the characters face.
    """
    x, y, z = point
    pitch, roll = tilt
    if pitch != 0.0:
        cosine = math.cos(pitch)
        sine = math.sin(pitch)
        y, z = y * cosine - z * sine, y * sine + z * cosine
    if roll != 0.0:
        cosine = math.cos(roll)
        sine = math.sin(roll)
        x, z = x * cosine + z * sine, -x * sine + z * cosine
    if turn != 0.0:
        cosine = math.cos(turn)
        sine = math.sin(turn)
        x, y = x * cosine - y * sine, x * sine + y * cosine
    return (origin[0] + x, origin[1] + y, origin[2] + z)


def joint(
    origin: tuple[float, float, float],
    reach: float,
    turn: float = 0.0,
    tilt: tuple[float, float] = (0.0, 0.0),
) -> tuple[float, float, float]:
    """Where the far end of a base-anchored limb ends up. Negative reach hangs."""
    return place((0.0, 0.0, reach), origin, turn, tilt)


def box_geometry(part: dict[str, Any]) -> tuple[list[tuple[float, float, float]], list[tuple[int, ...]]]:
    width, depth, height = part['size']
    x, y, z = (value / 2.0 for value in (width, depth, height))
    corners = [
        (-x, -y, -z),
        (x, -y, -z),
        (x, y, -z),
        (-x, y, -z),
        (-x, -y, z),
        (x, -y, z),
        (x, y, z),
        (-x, y, z),
    ]
    faces = [
        (0, 3, 2, 1),
        (4, 5, 6, 7),
        (0, 1, 5, 4),
        (1, 2, 6, 5),
        (2, 3, 7, 6),
        (3, 0, 4, 7),
    ]
    return corners, faces


def cylinder_geometry(
    part: dict[str, Any],
) -> tuple[list[tuple[float, float, float]], list[tuple[int, ...]]]:
    sides = part['sides']
    radius = part['radius']
    half = part['depth'] / 2.0
    ring = [
        (
            radius * math.cos(2.0 * math.pi * index / sides),
            radius * math.sin(2.0 * math.pi * index / sides),
        )
        for index in range(sides)
    ]
    points = [(x, y, -half) for x, y in ring] + [(x, y, half) for x, y in ring]
    points.append((0.0, 0.0, -half))
    points.append((0.0, 0.0, half))
    bottom, top = len(points) - 2, len(points) - 1
    faces: list[tuple[int, ...]] = []
    for index in range(sides):
        following = (index + 1) % sides
        faces.append((index, following, sides + following, sides + index))
        faces.append((bottom, following, index))
        faces.append((top, sides + index, sides + following))
    return points, faces


def cone_geometry(part: dict[str, Any]) -> tuple[list[tuple[float, float, float]], list[tuple[int, ...]]]:
    sides = part['sides']
    radius = part['radius']
    half = part['depth'] / 2.0
    ring = [
        (
            radius * math.cos(2.0 * math.pi * index / sides),
            radius * math.sin(2.0 * math.pi * index / sides),
        )
        for index in range(sides)
    ]
    points = [(x, y, -half) for x, y in ring] + [(0.0, 0.0, half), (0.0, 0.0, -half)]
    apex, centre = len(points) - 2, len(points) - 1
    faces: list[tuple[int, ...]] = []
    for index in range(sides):
        following = (index + 1) % sides
        faces.append((index, following, apex))
        faces.append((centre, following, index))
    return points, faces


def sphere_geometry(
    part: dict[str, Any],
) -> tuple[list[tuple[float, float, float]], list[tuple[int, ...]]]:
    segments = 16
    rings = 8
    radius = part['radius']
    points: list[tuple[float, float, float]] = [(0.0, 0.0, radius)]
    for ring in range(1, rings):
        phi = math.pi * ring / rings
        height = radius * math.cos(phi)
        rho = radius * math.sin(phi)
        for segment in range(segments):
            theta = 2.0 * math.pi * segment / segments
            points.append((rho * math.cos(theta), rho * math.sin(theta), height))
    points.append((0.0, 0.0, -radius))
    last = len(points) - 1

    def at(ring: int, segment: int) -> int:
        return 1 + (ring - 1) * segments + segment % segments

    faces: list[tuple[int, ...]] = []
    for segment in range(segments):
        faces.append((0, at(1, segment), at(1, segment + 1)))
    for ring in range(1, rings - 1):
        for segment in range(segments):
            faces.append(
                (
                    at(ring, segment),
                    at(ring + 1, segment),
                    at(ring + 1, segment + 1),
                    at(ring, segment + 1),
                )
            )
    for segment in range(segments):
        faces.append((last, at(rings - 1, segment + 1), at(rings - 1, segment)))
    return points, faces


def lathe_geometry(part: dict[str, Any]) -> tuple[list[tuple[float, float, float]], list[tuple[int, ...]]]:
    sides = part['sides']
    profile = part['profile']
    points: list[tuple[float, float, float]] = []
    levels: list[tuple[str, int]] = []

    for radius, z in profile:
        if abs(radius) < 1e-9:
            levels.append(('pole', len(points)))
            points.append((0.0, 0.0, z))
            continue
        levels.append(('ring', len(points)))
        for index in range(sides):
            angle = 2.0 * math.pi * index / sides
            points.append((radius * math.cos(angle), radius * math.sin(angle), z))

    faces: list[tuple[int, ...]] = []
    for lower, upper in zip(levels, levels[1:]):
        if lower[0] == 'ring' and upper[0] == 'ring':
            first, second = lower[1], upper[1]
            for index in range(sides):
                following = (index + 1) % sides
                faces.append((first + index, first + following, second + following, second + index))
        elif lower[0] == 'ring' and upper[0] == 'pole':
            first = lower[1]
            for index in range(sides):
                following = (index + 1) % sides
                faces.append((first + index, first + following, upper[1]))
        elif lower[0] == 'pole' and upper[0] == 'ring':
            second = upper[1]
            for index in range(sides):
                following = (index + 1) % sides
                faces.append((lower[1], second + following, second + index))
        else:
            raise ValueError('lathe profile has two consecutive poles')

    if part.get('cap_bottom', True) and levels[0][0] == 'ring':
        centre = len(points)
        points.append((0.0, 0.0, profile[0][1]))
        first = levels[0][1]
        for index in range(sides):
            following = (index + 1) % sides
            faces.append((centre, first + following, first + index))
    if part.get('cap_top', True) and levels[-1][0] == 'ring':
        centre = len(points)
        points.append((0.0, 0.0, profile[-1][1]))
        second = levels[-1][1]
        for index in range(sides):
            following = (index + 1) % sides
            faces.append((centre, second + index, second + following))
    return points, faces


def capsule_geometry(part: dict[str, Any]) -> tuple[list[tuple[float, float, float]], list[tuple[int, ...]]]:
    radius = part['radius']
    length = part['length']
    arcs = max(4, part['sides'] // 3)
    profile: list[tuple[float, float]] = []
    for index in range(arcs + 1):
        angle = (math.pi / 2.0) * index / arcs
        profile.append((radius * math.sin(angle), radius - radius * math.cos(angle)))
    for index in range(arcs + 1):
        angle = (math.pi / 2.0) * index / arcs
        profile.append((radius * math.cos(angle), length + radius * math.sin(angle)))
    if part.get('down', False):
        profile = [(r, z - length - 2.0 * radius) for r, z in reversed(profile)]
    return lathe_geometry(
        {
            'kind': 'lathe',
            'profile': tuple(profile),
            'sides': part['sides'],
            'cap_bottom': False,
            'cap_top': False,
        }
    )


def ellipsoid_geometry(part: dict[str, Any]) -> tuple[list[tuple[float, float, float]], list[tuple[int, ...]]]:
    segments = part['segments']
    rings = part['rings']
    rx, ry, rz = part['radius']
    points: list[tuple[float, float, float]] = [(0.0, 0.0, 2.0 * rz)]
    for ring in range(1, rings):
        phi = math.pi * ring / rings
        height = 2.0 * rz * math.cos(phi)
        for segment in range(segments):
            theta = 2.0 * math.pi * segment / segments
            points.append(
                (rx * math.sin(phi) * math.cos(theta), ry * math.sin(phi) * math.sin(theta), height)
            )
    points.append((0.0, 0.0, 0.0))
    last = len(points) - 1

    def at(ring: int, segment: int) -> int:
        return 1 + (ring - 1) * segments + segment % segments

    faces: list[tuple[int, ...]] = []
    for segment in range(segments):
        faces.append((0, at(1, segment), at(1, segment + 1)))
    for ring in range(1, rings - 1):
        for segment in range(segments):
            faces.append(
                (at(ring, segment), at(ring + 1, segment), at(ring + 1, segment + 1), at(ring, segment + 1))
            )
    for segment in range(segments):
        faces.append((last, at(rings - 1, segment + 1), at(rings - 1, segment)))
    return points, faces


def prism_geometry(part: dict[str, Any]) -> tuple[list[tuple[float, float, float]], list[tuple[int, ...]]]:
    authored = list(part['points'])
    extent = part['extent']
    if part.get('axis', 'z') == 'z':
        lower = [(x, y, 0.0) for x, y in authored]
        upper = [(x, y, extent) for x, y in authored]
    else:
        # Reversed so the fan caps wind outward once the profile lies in XZ.
        authored.reverse()
        half = extent / 2.0
        lower = [(x, -half, z) for x, z in authored]
        upper = [(x, half, z) for x, z in authored]
    count = len(authored)
    points = lower + upper
    points.append(
        (sum(p[0] for p in lower) / count, sum(p[1] for p in lower) / count, sum(p[2] for p in lower) / count)
    )
    points.append(
        (sum(p[0] for p in upper) / count, sum(p[1] for p in upper) / count, sum(p[2] for p in upper) / count)
    )
    low_centre, high_centre = 2 * count, 2 * count + 1
    faces: list[tuple[int, ...]] = []
    for index in range(count):
        following = (index + 1) % count
        faces.append((index, following, count + following, count + index))
        faces.append((low_centre, following, index))
        faces.append((high_centre, count + index, count + following))
    return points, faces


GEOMETRY = {
    'box': box_geometry,
    'cylinder': cylinder_geometry,
    'cone': cone_geometry,
    'sphere': sphere_geometry,
    'lathe': lathe_geometry,
    'capsule': capsule_geometry,
    'ellipsoid': ellipsoid_geometry,
    'prism': prism_geometry,
}


def validate_recipe(key: str, recipe: dict[str, Any]) -> None:
    """A recipe is a flat list of part dicts; catch mistakes before Blender does."""
    for index, part in enumerate(recipe['parts']):
        if not isinstance(part, dict):
            raise TypeError(
                f'recipe {key}: part {index} is {type(part).__name__}, not a part dict '
                '(a motif helper returning a list must be unpacked with *)'
            )
        if part.get('kind') not in GEOMETRY:
            raise ValueError(f'recipe {key}: part {index} has unknown kind {part.get("kind")!r}')


def build_mesh(key: str, parts: list[dict[str, Any]], palette: dict[str, str]) -> Any:
    """Turn a recipe into one object with one material slot per palette colour."""
    vertices: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []
    face_materials: list[int] = []
    face_smooth: list[bool] = []
    order: list[str] = []

    for part in parts:
        points, part_faces = GEOMETRY[part['kind']](part)
        offset = len(vertices)
        origin = part['at']
        turn = part.get('turn', 0.0)
        tilt = part.get('tilt', (0.0, 0.0))
        smooth = bool(part.get('smooth', False))
        vertices.extend(place(point, origin, turn, tilt) for point in points)
        colour = part['colour']
        if colour not in order:
            order.append(colour)
        slot = order.index(colour)
        for face in part_faces:
            faces.append(tuple(offset + index for index in face))
            face_materials.append(slot)
            face_smooth.append(smooth)

    mesh = bpy.data.meshes.new(key)
    mesh.from_pydata(vertices, [], faces)
    mesh.validate()
    mesh.update()

    # validate() drops degenerate faces, which would shift every material slot
    # after the dropped one. Recipes are expected to be clean; fail loudly if not.
    if len(mesh.polygons) != len(face_materials):
        raise ValueError(
            f'{key}: {len(face_materials) - len(mesh.polygons)} face(s) were rejected as degenerate'
        )

    for colour in order:
        mesh.materials.append(material_for(colour, palette))
    for polygon, slot, smooth in zip(mesh.polygons, face_materials, face_smooth):
        polygon.material_index = slot
        polygon.use_smooth = smooth

    obj = bpy.data.objects.new(key, mesh)
    bpy.context.collection.objects.link(obj)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    return obj


def build_asset(
    key: str, recipe: dict[str, Any], palette: dict[str, str], out_dir: Path, repo_root: Path
) -> dict[str, Any]:
    validate_recipe(key, recipe)
    reset_scene()
    asset = build_mesh(key, recipe['parts'], palette)

    target = out_dir / f'{key}.glb'
    target.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(target),
        export_format='GLB',
        use_selection=True,
        export_apply=False,
    )
    return describe(asset, recipe, target, repo_root)


def describe(asset: Any, recipe: dict[str, Any], path: Path, repo_root: Path) -> dict[str, Any]:
    """A structural fingerprint rather than a byte fingerprint.

    The generator is byte-stable by construction, but the fingerprint is still
    what CI compares: a Blender upgrade may legitimately change float formatting
    without changing the kit.
    """
    mesh = asset.data
    xs = [vertex.co.x for vertex in mesh.vertices]
    ys = [vertex.co.y for vertex in mesh.vertices]
    zs = [vertex.co.z for vertex in mesh.vertices]
    return {
        'key': asset.name,
        'glbPath': path.relative_to(repo_root).as_posix(),
        'bytes': path.stat().st_size,
        'scale': recipe['scale'],
        'tags': recipe['tags'],
        'animated': False,
        'animations': [],
        'vertices': len(mesh.vertices),
        'triangles': sum(len(polygon.vertices) - 2 for polygon in mesh.polygons),
        'materials': sorted({slot.material.name for slot in asset.material_slots if slot.material}),
        'bounds': [
            round(max(xs) - min(xs), 3),
            round(max(ys) - min(ys), 3),
            round(max(zs) - min(zs), 3),
        ],
    }


# --------------------------------------------------------------------------- #
# --------------------------------------------------------------------------- #
# Portraits
# --------------------------------------------------------------------------- #


def strip_png_text_chunks(path: Path) -> int:
    """Drop `tEXt`/`zTXt`/`iTXt` chunks and rewrite the file with valid CRCs.

    These carry the render date and Cycles timings, which differ between
    otherwise identical renders. Returns the number of chunks removed.
    """
    data = path.read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError(f'{path} is not a PNG')
    dropped = 0
    output = bytearray(data[:8])
    offset = 8
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError(f'{path}: truncated chunk header at byte {offset}')
        length = int.from_bytes(data[offset : offset + 4], 'big')
        kind = data[offset + 4 : offset + 8]
        end = offset + 12 + length
        if end > len(data):
            raise ValueError(f'{path}: chunk {kind!r} claims {length} bytes but the file ends early')
        chunk = data[offset:end]
        if kind in (b'tEXt', b'zTXt', b'iTXt'):
            dropped += 1
        else:
            output += chunk
        offset = end
    if output[-8:-4] != b'IEND':
        raise ValueError(f'{path}: last chunk is {bytes(output[-8:-4])!r}, expected IEND')
    if dropped:
        path.write_bytes(bytes(output))
    return dropped


def render_portrait(archetype: str, out_path: Path, palette: dict[str, str], size: int = 256) -> None:
    reset_scene()
    build_mesh(f'portrait_{archetype}', character(archetype), palette)

    # Framed as a bust: waist to just above the crown, so the face reads at the
    # 48-96 px the lobby actually draws.
    bpy.ops.object.camera_add(location=(0.0, -2.05, 0.94), rotation=(math.radians(90.0), 0.0, 0.0))
    camera = bpy.context.active_object
    camera.data.lens = 55.0
    bpy.context.scene.camera = camera
    bpy.ops.object.light_add(type='AREA', location=(1.1, -1.6, 2.4))
    bpy.context.active_object.data.energy = 90.0
    bpy.context.active_object.data.size = 1.6
    bpy.ops.object.light_add(type='SUN', location=(-2.0, 2.0, 4.0))
    bpy.context.active_object.data.energy = 1.4

    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 24
    scene.cycles.use_denoising = False
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    # Cycles samples across threads and its accumulation order is not stable, so
    # two identical renders can differ in the last bit of a pixel. Pinning the
    # seed and rendering single-threaded makes the PNG bytes reproducible.
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = 1
    scene.render.filepath = str(out_path)
    # The default AgX view transform desaturates hard, which reads as washed out
    # next to the high-saturation UI swatches. Standard keeps the tokens honest.
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    # Blender stamps render metadata into PNG text chunks by default, including
    # the wall-clock date and Cycles timings, which would make an otherwise
    # identical render differ byte for byte.
    for attribute in dir(scene.render):
        if attribute.startswith('use_stamp'):
            setattr(scene.render, attribute, False)
    world = bpy.data.worlds.new('PortraitWorld')
    world_tree = world.node_tree
    if world_tree is None:
        world.use_nodes = True
        world_tree = world.node_tree
    world_tree.nodes['Background'].inputs['Color'].default_value = (0.62, 0.62, 0.62, 1.0)
    scene.world = world
    bpy.ops.render.render(write_still=True)
    strip_png_text_chunks(out_path)


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def collect_asset_keys(repo_root: Path, config: dict[str, Any]) -> list[str]:
    """Derive the build list from the shipped content so it cannot drift.

    The map declares the tiles and props it places; the character file declares
    each character's model and portrait. Whatever those reference is what must
    exist, so this list is the union of both.
    """
    keys: list[str] = []

    map_path = repo_root / config['sources']['map']
    map_definition = json.loads(map_path.read_text(encoding='utf-8'))
    for key in map_definition['assets']:
        if key not in keys:
            keys.append(key)

    characters_path = repo_root / config['sources']['characters']
    for character_entry in json.loads(characters_path.read_text(encoding='utf-8')):
        for field in ('modelRef', 'portraitRef'):
            reference = character_entry.get(field)
            if reference and reference not in keys:
                keys.append(reference)
    return keys


def main() -> int:
    args = parse_args(sys.argv)
    repo_root = Path(__file__).resolve().parent.parent
    config_path = (repo_root / args.config).resolve()
    config = json.loads(config_path.read_text(encoding='utf-8'))
    out_dir = (repo_root / args.out).resolve()

    theme = json.loads((repo_root / config['themeTokens']).read_text(encoding='utf-8'))
    palette: dict[str, str] = theme['colors']

    recipes = RECIPES()
    wanted = collect_asset_keys(repo_root, config)
    if args.only:
        requested = {item.strip() for item in args.only.split(',') if item.strip()}
        wanted = [key for key in wanted if key in requested]

    missing = [key for key in wanted if not key.startswith('portrait_') and key not in recipes]
    if missing:
        print(f'BUILD_ERROR missing recipes: {", ".join(missing)}', file=sys.stderr)
        return 2

    out_dir.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, Any]] = []
    for key in wanted:
        if key.startswith('portrait_'):
            continue
        entries.append(build_asset(key, recipes[key], palette, out_dir, repo_root))
        print(f'built {key}')

    portraits: list[dict[str, Any]] = []
    for key in wanted:
        if not key.startswith('portrait_'):
            continue
        archetype = key.removeprefix('portrait_')
        if archetype not in CHARACTER_BUILDERS:
            print(f'BUILD_ERROR unknown portrait archetype: {key}', file=sys.stderr)
            return 2
        target = out_dir / f'{key}.png'
        render_portrait(archetype, target, palette)
        portraits.append(
            {
                'key': key,
                'pngPath': target.relative_to(repo_root).as_posix(),
                'bytes': target.stat().st_size,
                'scale': 1.0,
                'tags': ['portrait', f'archetype:{archetype}'],
                'animated': False,
                'animations': [],
            }
        )
        print(f'rendered {key}')

    manifest = {
        'version': 1,
        'seed': args.seed,
        'blender': bpy.app.version_string,
        'assets': entries + portraits,
    }
    # Explicit newline: Python text mode writes CRLF on Windows, which shows up
    # as a spurious diff against the LF-normalised index.
    (out_dir / config['manifestName']).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + '\n',
        encoding='utf-8',
        newline='\n',
    )
    print(f'BUILD_OK {len(entries)} meshes, {len(portraits)} portraits')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
