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


def hex_to_rgb(value: str) -> tuple[float, float, float]:
    text = value.lstrip('#')
    if len(text) != 6:
        raise ValueError(f'not a hex colour: {value}')
    return tuple(int(text[index : index + 2], 16) / 255.0 for index in (0, 2, 4))  # type: ignore[return-value]


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


# --------------------------------------------------------------------------- #
# Motifs
# --------------------------------------------------------------------------- #

BASE = [
    box((2.0, 2.0, 0.2), (0.0, 0.0, 0.1), 'ringBase'),
    box((2.06, 0.12, 0.06), (0.0, -1.0, 0.21), 'ringEdge'),
    box((2.06, 0.12, 0.06), (0.0, 1.0, 0.21), 'ringEdge'),
    box((0.12, 2.06, 0.06), (-1.0, 0.0, 0.21), 'ringEdge'),
    box((0.12, 2.06, 0.06), (1.0, 0.0, 0.21), 'ringEdge'),
]


def cylinders_tree(radius: float, x: float) -> list[dict[str, Any]]:
    return [
        cylinder(0.07, 0.5, (x, 0.0, 0.45), 'uiText', 6),
        sphere(radius, (x, 0.0, 0.95), 'groupBlue'),
    ]


def slab(width: float, depth: float, height: float, colour: str, x: float = 0.0, y: float = 0.0) -> dict[str, Any]:
    return box((width, depth, height), (x, y, 0.2 + height / 2), colour)


def tower(
    width: float,
    depth: float,
    height: float,
    colour: str,
    cap: str = 'accentPrimary',
    levels: int = 1,
    x: float = 0.0,
    y: float = 0.0,
) -> list[dict[str, Any]]:
    parts = [slab(width, depth, height, colour, x, y)]
    parts.append(slab(width * 1.08, depth * 1.08, 0.12, cap, x, y))
    for level in range(levels):
        band = height * (level + 0.5) / levels
        parts.append(slab(width * 1.02, depth * 0.2, 0.1, 'accentCool', x, y - depth / 2))
        parts.append(box((width * 0.24, 0.04, 0.22), (x, y - depth / 2 - 0.02, 0.2 + band), 'accentCool'))
    return parts


def house(level: int) -> list[dict[str, Any]]:
    """The four upgrade levels of an owned property, smallest to largest."""
    width = 0.7 + 0.16 * level
    height = 0.35 + 0.34 * level
    colour = ['groupBlue', 'groupYellow', 'groupRed', 'groupGold'][level - 1]
    parts = [slab(width, width, height, colour)]
    parts.append(box((width * 1.16, width * 1.16, 0.1), (0.0, 0.0, 0.2 + height), 'accentPrimary'))
    parts.append(cylinder(width * 0.22, 0.34, (0.0, 0.0, 0.2 + height + 0.24), 'uiHighlight', 10))
    if level >= 2:
        parts.append(slab(width * 0.42, width * 0.42, height * 0.7, colour, width * 0.34, width * 0.34))
        parts.append(box((width * 0.5, width * 0.5, 0.08), (width * 0.34, width * 0.34, 0.2 + height * 0.7), 'accentPrimary'))
    if level >= 3:
        parts.append(slab(width * 0.36, width * 0.36, height * 1.1, colour, -width * 0.4, width * 0.36))
        parts.append(box((width * 0.44, width * 0.44, 0.08), (-width * 0.4, width * 0.36, 0.2 + height * 1.1), 'accentPrimary'))
    if level >= 4:
        parts.append(cone(width * 0.34, 0.5, (0.0, 0.0, 0.2 + height + 0.6), 'accentSecondary', 12))
    return parts


def dice() -> list[dict[str, Any]]:
    parts = [box((0.7, 0.7, 0.7), (0.0, 0.0, 0.55), 'uiPanel')]
    pips = [(0.0, 0.0), (0.18, 0.18), (-0.18, 0.18), (0.18, -0.18), (-0.18, -0.18)]
    for x, y in pips:
        parts.append(cylinder(0.055, 0.06, (x, y, 0.91), 'uiText', 8))
    parts.append(cylinder(0.055, 0.06, (0.0, 0.36, 0.55), 'uiText', 8))
    return parts


CHARACTER_BUILDERS: dict[str, list[dict[str, Any]]] = {
    'farmer': [
        cylinder(0.34, 0.62, (0.0, 0.0, 0.51), 'player_farmer', 14),
        sphere(0.3, (0.0, 0.0, 0.95), 'uiPanel'),
        cylinder(0.54, 0.06, (0.0, 0.0, 1.16), 'accentSecondary', 16),
        cone(0.3, 0.26, (0.0, 0.0, 1.26), 'accentSecondary', 12),
        box((0.16, 0.16, 0.3), (0.34, 0.0, 0.6), 'uiPanel'),
        box((0.16, 0.16, 0.3), (-0.34, 0.0, 0.6), 'uiPanel'),
    ],
    'girl': [
        cylinder(0.3, 0.56, (0.0, 0.0, 0.48), 'player_girl', 14),
        sphere(0.28, (0.0, 0.0, 0.88), 'uiPanel'),
        sphere(0.16, (0.24, 0.0, 1.06), 'player_girl'),
        sphere(0.16, (-0.24, 0.0, 1.06), 'player_girl'),
        box((0.14, 0.14, 0.28), (0.3, 0.0, 0.56), 'uiPanel'),
        box((0.14, 0.14, 0.28), (-0.3, 0.0, 0.56), 'uiPanel'),
    ],
    'madame': [
        cylinder(0.32, 0.3, (0.0, 0.0, 0.35), 'player_madame', 14),
        cylinder(0.36, 0.62, (0.0, 0.0, 0.81), 'player_madame', 14),
        sphere(0.3, (0.0, 0.0, 1.26), 'uiPanel'),
        sphere(0.38, (0.0, 0.0, 1.3), 'player_madame'),
        box((0.2, 0.16, 0.24), (0.42, 0.0, 0.62), 'accentSecondary'),
        box((0.14, 0.14, 0.28), (-0.42, 0.0, 0.78), 'uiPanel'),
    ],
    'ninja': [
        cylinder(0.3, 0.6, (0.0, 0.0, 0.5), 'player_ninja', 14),
        sphere(0.27, (0.0, 0.0, 0.9), 'uiText'),
        cylinder(0.29, 0.09, (0.0, 0.0, 0.96), 'accentPrimary', 16),
        box((0.5, 0.06, 0.14), (0.0, -0.24, 1.0), 'accentPrimary'),
        box((0.14, 0.14, 0.3), (0.32, 0.0, 0.58), 'uiText'),
        box((0.14, 0.14, 0.3), (-0.32, 0.0, 0.58), 'uiText'),
    ],
}


def character(archetype: str) -> list[dict[str, Any]]:
    body = CHARACTER_BUILDERS[archetype]
    return body


# --------------------------------------------------------------------------- #
# Recipes: one entry per declared asset key
# --------------------------------------------------------------------------- #


def RECIPES() -> dict[str, dict[str, Any]]:  # noqa: N802 - reads as a table
    table: dict[str, dict[str, Any]] = {}

    def add(key: str, parts: Iterable[dict[str, Any]], tags: Sequence[str], scale: float = 1.0) -> None:
        table[key] = {'parts': list(parts), 'tags': list(tags), 'scale': scale}

    # -- ring tiles -------------------------------------------------------- #
    add('city.road', BASE + [box((1.8, 1.8, 0.04), (0.0, 0.0, 0.2), 'road')], ['tile', 'ring-base'])
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
        BASE + tower(1.15, 1.15, 0.85, 'uiPanel', 'accentCool', 1) + [box((0.5, 0.12, 0.12), (0.0, -0.62, 1.2), 'accentPrimary'), box((0.12, 0.12, 0.5), (0.0, -0.62, 1.2), 'accentPrimary')],
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
        BASE + tower(1.15, 1.15, 0.95, 'uiPanel', 'accentPrimary', 1) + [cone(0.95, 0.55, (0.0, 0.0, 1.5), 'accentPrimary', 6), cylinder(0.08, 0.5, (0.0, 0.0, 1.95), 'uiText', 8)],
        ['tile', 'building', 'chaos'],
    )
    add(
        'city.office_tower',
        BASE + tower(1.0, 1.0, 1.7, 'accentCool', 'uiPanel', 4),
        ['tile', 'building', 'group:blue'],
    )
    add(
        'city.studio',
        BASE + tower(1.2, 1.2, 1.1, 'groupRed', 'accentSecondary', 2) + [cylinder(0.2, 0.5, (0.6, 0.6, 1.55), 'accentPrimary', 10)],
        ['tile', 'building', 'group:red'],
    )
    add(
        'city.mall',
        BASE + tower(1.5, 1.3, 1.15, 'groupGold', 'accentPrimary', 2) + [box((1.7, 1.5, 0.12), (0.0, 0.0, 1.5), 'uiPanel')],
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
        BASE + tower(1.1, 1.1, 1.9, 'accentCool', 'uiPanel', 5),
        ['tile', 'building', 'group:blue'],
    )
    add(
        'city.bonus_chest',
        BASE + [box((0.9, 0.7, 0.6), (0.0, 0.0, 0.5), 'groupGold'), box((0.96, 0.76, 0.14), (0.0, 0.0, 0.85), 'accentSecondary'), cylinder(0.12, 0.2, (0.0, 0.0, 0.6), 'accentPrimary', 10)],
        ['tile', 'bonus'],
    )
    add(
        'city.skyscraper',
        BASE + tower(0.95, 0.95, 2.3, 'uiPanel', 'accentCool', 6) + [cylinder(0.06, 0.7, (0.0, 0.0, 2.9), 'accentPrimary', 6)],
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
        BASE + [box((0.9, 0.9, 2.0), (0.0, 0.0, 1.2), 'uiPanel'), box((1.0, 1.0, 0.14), (0.0, 0.0, 2.25), 'accentCool'), box((0.7, 0.06, 0.9), (0.0, -0.47, 1.3), 'accentCool')],
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


def add_part(part: dict[str, Any], palette: dict[str, str]) -> Any:
    kind = part['kind']
    x, y, z = part['at']
    if kind == 'box':
        width, depth, height = part['size']
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(x, y, z))
        obj = bpy.context.active_object
        obj.scale = (width, depth, height)
    elif kind == 'cylinder':
        bpy.ops.mesh.primitive_cylinder_add(
            vertices=part['sides'], radius=part['radius'], depth=part['depth'], location=(x, y, z)
        )
        obj = bpy.context.active_object
    elif kind == 'cone':
        bpy.ops.mesh.primitive_cone_add(
            vertices=part['sides'], radius1=part['radius'], radius2=0.0, depth=part['depth'], location=(x, y, z)
        )
        obj = bpy.context.active_object
    elif kind == 'sphere':
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=part['radius'], location=(x, y, z))
        obj = bpy.context.active_object
    else:  # pragma: no cover - guarded by the recipe table
        raise ValueError(f'unknown part kind: {kind}')

    if part.get('turn'):
        obj.rotation_euler[2] = part['turn']
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    material = material_for(part['colour'], palette)
    obj.data.materials.append(material)
    return obj


def validate_recipe(key: str, recipe: dict[str, Any]) -> None:
    """A recipe is a flat list of part dicts; catch nesting before Blender does."""
    for index, part in enumerate(recipe['parts']):
        if not isinstance(part, dict):
            raise TypeError(
                f'recipe {key}: part {index} is {type(part).__name__}, not a part dict '
                '(a motif helper returning a list must be unpacked with *)'
            )


def build_asset(
    key: str, recipe: dict[str, Any], palette: dict[str, str], out_dir: Path, repo_root: Path
) -> dict[str, Any]:
    validate_recipe(key, recipe)
    reset_scene()
    built = [add_part(part, palette) for part in recipe['parts']]

    bpy.ops.object.select_all(action='DESELECT')
    for obj in built:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = built[0]
    if len(built) > 1:
        bpy.ops.object.join()
    asset = bpy.context.active_object
    asset.name = key

    target = out_dir / f'{key}.glb'
    target.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(target),
        export_format='GLB',
        use_selection=True,
        export_apply=True,
    )
    return describe(asset, recipe, target, repo_root)


def describe(asset: Any, recipe: dict[str, Any], path: Path, repo_root: Path) -> dict[str, Any]:
    """A structural fingerprint, not a byte fingerprint.

    Float noise and exporter changes make byte equality useless across Blender
    builds and platforms; shape, material and size are stable.
    """
    mesh = asset.data
    corners = [asset.matrix_world @ Vector(corner) for corner in asset.bound_box]
    xs = [corner.x for corner in corners]
    ys = [corner.y for corner in corners]
    zs = [corner.z for corner in corners]
    return {
        'key': asset.name,
        'glbPath': path.relative_to(repo_root).as_posix(),
        'bytes': path.stat().st_size,
        'scale': recipe['scale'],
        'tags': recipe['tags'],
        'animated': False,
        'vertices': len(mesh.vertices),
        'triangles': sum(len(polygon.vertices) - 2 for polygon in mesh.polygons),
        'materials': sorted({slot.material.name for slot in asset.material_slots if slot.material}),
        'bounds': [
            round(round(max(xs) - min(xs), 3) if xs else 0.0, 3),
            round(round(max(ys) - min(ys), 3) if ys else 0.0, 3),
            round(round(max(zs) - min(zs), 3) if zs else 0.0, 3),
        ],
    }


# --------------------------------------------------------------------------- #
# Portraits
# --------------------------------------------------------------------------- #


def render_portrait(archetype: str, out_path: Path, palette: dict[str, str], size: int = 256) -> None:
    reset_scene()
    for part in character(archetype):
        add_part(part, palette)

    bpy.ops.object.camera_add(location=(0.0, -3.4, 1.05), rotation=(math.radians(90.0), 0.0, 0.0))
    camera = bpy.context.active_object
    bpy.context.scene.camera = camera
    bpy.ops.object.light_add(type='AREA', location=(1.6, -2.2, 3.0))
    bpy.context.active_object.data.energy = 900.0
    bpy.ops.object.light_add(type='SUN', location=(-2.0, 2.0, 4.0))

    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 24
    scene.cycles.use_denoising = False
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = str(out_path)
    world = bpy.data.worlds.new('PortraitWorld')
    world_tree = world.node_tree
    if world_tree is None:
        world.use_nodes = True
        world_tree = world.node_tree
    world_tree.nodes['Background'].inputs['Color'].default_value = (0.95, 0.95, 0.95, 1.0)
    scene.world = world
    bpy.ops.render.render(write_still=True)


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
            }
        )
        print(f'rendered {key}')

    manifest = {
        'version': 1,
        'seed': args.seed,
        'blender': bpy.app.version_string,
        'assets': entries + portraits,
    }
    (out_dir / config['manifestName']).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8'
    )
    print(f'BUILD_OK {len(entries)} meshes, {len(portraits)} portraits')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
