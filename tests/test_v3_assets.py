"""CPU checks of the shipped V3 model, without viewers, hardware or model downloads.

By default use this checkout's assets. For an installed wheel, explicitly set
GMR_TEST_ASSET_ROOT to its general_motion_retargeting/assets directory; a missing
package resource is an error and never falls back to the checkout.
"""
import os
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

import mujoco
import numpy as np


def materialized_file(path):
    if not path.is_file():
        raise AssertionError(f"Missing model resource: {path}")
    with path.open("rb") as stream:
        prefix = stream.read(128)
    if not prefix or prefix.startswith(b"version https://git-lfs.github.com/spec/v1"):
        raise AssertionError(f"Model resource is empty or an unresolved LFS pointer: {path}")


class V3AssetsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        selected = os.environ.get("GMR_TEST_ASSET_ROOT")
        cls.assets = (Path(selected).expanduser() if selected is not None
                      else Path(__file__).resolve().parents[1] / "assets").resolve()
        if selected == "":
            raise AssertionError("GMR_TEST_ASSET_ROOT must name an asset directory")
        cls.xml = cls.assets / "autolife_s2_hands" / "robot_v2_2.xml"
        materialized_file(cls.xml)
        cls.document = ET.parse(cls.xml).getroot()
        compiler = cls.document.find("compiler")
        meshdir = compiler.get("meshdir", "") if compiler is not None else ""
        cls.meshes = []
        for mesh in cls.document.findall("./asset/mesh"):
            path = (cls.xml.parent / meshdir / mesh.attrib["file"]).resolve()
            if not path.is_relative_to(cls.assets):
                raise AssertionError(f"Mesh escapes the selected asset directory: {path}")
            materialized_file(path)
            cls.meshes.append(path)
        cls.model = mujoco.MjModel.from_xml_path(str(cls.xml))

    def test_meshes_and_robot_control_joints_are_present(self):
        self.assertTrue(self.meshes, "The robot must load real meshes")
        self.assertEqual(self.model.nmesh, len(self.meshes))
        # These named joints are consumed by the existing V3 retarget/controller.
        for name in (
            "Joint_Ground_Vehicle_X", "Joint_Ground_Vehicle_Y", "Joint_Ground_Vehicle_Z",
            "Joint_Waist_Pitch", "Joint_Waist_Yaw", "Joint_Left_Elbow", "Joint_Right_Elbow",
            "Joint_Neck_Roll", "Joint_Neck_Pitch", "Joint_Neck_Yaw",
            "Left_DH116_finger12", "Right_DH116_finger12",
        ):
            with self.subTest(joint=name):
                joint = self.model.joint(name)
                self.assertGreaterEqual(joint.id, 0)
                self.assertTrue(joint.limited[0])
                self.assertLess(joint.range[0], joint.range[1])
        self.assertGreater(self.model.nq, 0)
        self.assertGreater(self.model.nv, 0)

    def test_elbow_motion_moves_only_its_hand_chain(self):
        data = mujoco.MjData(self.model)
        address = self.model.joint("Joint_Left_Elbow").qposadr[0]
        data.qpos[address] = 0.3
        mujoco.mj_forward(self.model, data)
        left_before = data.body("Left_DH116_base_link").xpos.copy()
        right_before = data.body("Right_DH116_base_link").xpos.copy()
        data.qpos[address] = 0.9
        mujoco.mj_forward(self.model, data)
        self.assertGreater(np.linalg.norm(data.body("Left_DH116_base_link").xpos - left_before), 0.01)
        np.testing.assert_allclose(data.body("Right_DH116_base_link").xpos, right_before, atol=1e-12, rtol=0)

    def test_physics_advances_with_finite_reproducible_state(self):
        states = []
        for _ in range(2):
            data = mujoco.MjData(self.model)
            data.qvel[self.model.joint("Joint_Ground_Vehicle_X").dofadr[0]] = 0.1
            initial = data.qpos.copy()
            for _ in range(10):
                mujoco.mj_step(self.model, data)
                for value in (data.qpos, data.qvel, data.qacc, data.xpos):
                    self.assertTrue(np.isfinite(value).all())
            self.assertAlmostEqual(data.time, 10 * self.model.opt.timestep)
            self.assertGreater(np.linalg.norm(data.qpos - initial), 1e-6)
            states.append(np.concatenate((data.qpos, data.qvel)))
        np.testing.assert_allclose(states[0], states[1], atol=1e-12, rtol=0)


if __name__ == "__main__":
    unittest.main()
