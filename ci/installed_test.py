"""Installed-package assertions. Executed outside the source checkout."""
from importlib.metadata import distribution
from importlib.util import find_spec
import os
from pathlib import Path
import sys

original = Path(os.environ['AUTOLIFE_TEST_PACKAGE'])
assert distribution('general-motion-retargeting').version == os.environ['AUTOLIFE_TEST_VERSION']
assert Path(find_spec('general_motion_retargeting').origin).is_relative_to(Path(sys.prefix))
from general_motion_retargeting import AUTOLIFE_S2_HANDS_ASSET_ROOT, IK_CONFIG_ROOT
import mujoco
import numpy as np

xml = Path(AUTOLIFE_S2_HANDS_ASSET_ROOT)/'robot_v2_2.xml'
assert xml.is_relative_to(Path(sys.prefix)) and any(Path(IK_CONFIG_ROOT).glob('*.json'))
model = mujoco.MjModel.from_xml_path(str(xml))
assert model.nmesh > 0 and model.joint('Joint_Left_Elbow').id >= 0
data = mujoco.MjData(model)
mujoco.mj_step(model, data)
assert data.time > 0 and np.isfinite(data.qpos).all()
