"""Render a contact sheet of built GLB assets so a human (or an agent) can look at them.

Usage:
    blender --background --python scripts/preview_assets.py -- \
        --keys char_farmer char_girl city.house_1 city.office_tower \
        --out .tmp/preview/characters.png --columns 4

This is a development aid only; it is not part of the asset pipeline.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path
from typing import Any, Sequence

import bpy  # type: ignore[import-not-found]
from mathutils import Vector  # type: ignore[import-not-found]


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keys", nargs="+", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--models", default="public/models")
    parser.add_argument("--columns", type=int, default=4)
    parser.add_argument("--width", type=int, default=420)
    parser.add_argument("--height", type=int, default=520)
    parser.add_argument("--samples", type=int, default=48)
    parser.add_argument("--view", default="quarter", choices=("quarter", "front", "head"))
    return parser.parse_args(argv)


def clear() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def world_backdrop(colour: tuple[float, float, float, float]) -> None:
    world = bpy.data.worlds.new("preview-world")
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs[0].default_value = colour
    background.inputs[1].default_value = 0.45
    bpy.context.scene.world = world


def import_glb(path: Path) -> list[Any]:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    return [obj for obj in bpy.data.objects if obj not in before]


def bounds(objects: Sequence[Any]) -> tuple[Vector, Vector]:
    corners = [
        obj.matrix_world @ Vector(corner)
        for obj in objects
        if obj.type == "MESH"
        for corner in obj.bound_box
    ]
    if not corners:
        return Vector((0.0, 0.0, 0.0)), Vector((0.0, 0.0, 0.0))
    low = Vector((min(c[a] for c in corners) for a in range(3)))
    high = Vector((max(c[a] for c in corners) for a in range(3)))
    return low, high


def place_camera(centre: Any, radius: float, scene: Any, view: str = "quarter") -> None:
    camera_data = bpy.data.cameras.new("preview-camera")
    camera_data.lens = 55.0
    camera = bpy.data.objects.new("preview-camera", camera_data)
    scene.collection.objects.link(camera)
    if view == "head":
        # Close on the face band, which is where the eyes and the brows are.
        centre = (centre[0], centre[1], centre[2] + radius * 0.34)
        distance = radius * 1.9
        camera.location = (centre[0], centre[1] - distance, centre[2] + distance * 0.06)
    elif view == "front":
        distance = radius * 3.1
        camera.location = (centre[0], centre[1] - distance, centre[2] + distance * 0.10)
    else:
        distance = radius * 3.1
        camera.location = (
            centre[0] + distance * 0.62,
            centre[1] - distance * 0.78,
            centre[2] + distance * 0.44,
        )
    target = bpy.data.objects.new("preview-target", None)
    scene.collection.objects.link(target)
    target.location = centre
    constraint = camera.constraints.new("TRACK_TO")
    constraint.target = target
    constraint.track_axis = "TRACK_NEGATIVE_Z"
    constraint.up_axis = "UP_Y"
    scene.camera = camera


def place_lights(centre: Any, radius: float, scene: Any) -> None:
    key_data = bpy.data.lights.new("key", type="AREA")
    key_data.energy = 55.0 * radius * radius + 40.0
    key_data.size = radius * 1.6
    key = bpy.data.objects.new("key", key_data)
    key.location = (centre[0] + radius * 1.9, centre[1] - radius * 1.9, centre[2] + radius * 2.6)
    scene.collection.objects.link(key)

    fill_data = bpy.data.lights.new("fill", type="AREA")
    fill_data.energy = 22.0 * radius * radius + 18.0
    fill_data.size = radius * 2.2
    fill = bpy.data.objects.new("fill", fill_data)
    fill.location = (centre[0] - radius * 2.2, centre[1] - radius * 1.2, centre[2] + radius * 1.4)
    scene.collection.objects.link(fill)

    sun_data = bpy.data.lights.new("sun", type="SUN")
    sun_data.energy = 1.9
    sun = bpy.data.objects.new("sun", sun_data)
    sun.rotation_euler = (math.radians(52.0), 0.0, math.radians(38.0))
    scene.collection.objects.link(sun)


def render_group(
    keys: Sequence[str],
    models: Path,
    out_path: Path,
    columns: int,
    width: int,
    height: int,
    samples: int,
    view: str = "quarter",
) -> None:
    scene = bpy.context.scene
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    try:
        scene.render.engine = "CYCLES"
        scene.cycles.samples = samples
        scene.cycles.use_denoising = True
    except (AttributeError, TypeError):
        pass
    # AgX flattens saturated albedo into pastel; the point of this sheet is to
    # judge the colours that ship, so use the untone-mapped transform.
    try:
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
    except (AttributeError, TypeError):
        pass

    cleared = False
    for index, key in enumerate(keys):
        path = models / f"{key}.glb"
        if not path.exists():
            print(f"missing {path}", file=sys.stderr)
            continue
        slot_objects = import_glb(path)
        bpy.context.view_layer.update()
        # Pull every model back to its own origin, then lay the group out in a
        # grid whose pitch scales with the biggest thing on the sheet.
        low, high = bounds(slot_objects)
        footprint = max(high[0] - low[0], high[1] - low[1], 0.4)
        pitch = footprint * 1.35
        offset_x = (index % columns) * pitch
        offset_y = (index // columns) * pitch
        for obj in slot_objects:
            if obj.parent is None:
                obj.location.x += offset_x - (low[0] + high[0]) / 2.0
                obj.location.y += offset_y - (low[1] + high[1]) / 2.0
                obj.location.z -= low[2]
        cleared = True
        bpy.context.view_layer.update()

    if not cleared:
        raise SystemExit("nothing imported")

    everything = [obj for obj in scene.objects if obj.type == "MESH"]
    bpy.context.view_layer.update()
    low, high = bounds(everything)
    centre = tuple((low[a] + high[a]) / 2.0 for a in range(3))
    span = max(high[0] - low[0], high[1] - low[1], high[2] - low[2], 0.5)
    print(f"preview: centre={centre} span={span} meshes={len(everything)}")
    place_camera(centre, span / 2.0, scene, view)
    place_lights(centre, span / 2.0, scene)
    print(f"preview: camera={tuple(round(c, 2) for c in scene.camera.location)}")
    world_backdrop((0.16, 0.17, 0.21, 1.0))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(out_path)
    bpy.ops.render.render(write_still=True)
    print(f"wrote {out_path}")


def main() -> int:
    args = parse_args(sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else [])
    clear()
    render_group(
        args.keys,
        Path(args.models),
        Path(args.out),
        args.columns,
        args.width,
        args.height,
        args.samples,
        args.view,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
