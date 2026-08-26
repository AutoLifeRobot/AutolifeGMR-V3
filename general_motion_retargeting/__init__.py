import os
import toml
import json
import pathlib

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.path.pardir))
PACKAGE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__)))

if os.path.exists(os.path.abspath(os.path.join(PROJECT_ROOT, 'assets'))):
    ASSETS_ROOT = os.path.abspath(os.path.join(PROJECT_ROOT, 'assets'))
elif os.path.exists(os.path.abspath(os.path.join(PACKAGE_ROOT, 'assets'))):
    ASSETS_ROOT = os.path.abspath(os.path.join(PACKAGE_ROOT, 'assets'))
else:
    raise FileNotFoundError("Assets directory not found in PROJECT_ROOT or PACKAGE_ROOT.")

IK_CONFIG_ROOT = None
AUTOLIFE_S2_HANDS_ASSET_ROOT = None

def load_vision():
    global AUTOLIFE_S2_HANDS_ASSET_ROOT, IK_CONFIG_ROOT
    AUTOLIFE_S2_HANDS_ASSET_ROOT = pathlib.Path(f'{ASSETS_ROOT}/autolife_s2_hands')
    IK_CONFIG_ROOT = pathlib.Path(f'{PACKAGE_ROOT}/ik_config')

# Call the function to load the appropriate value based on the ACTIVE_ROBOT_VERSION
load_vision()

from rich import print
from .params import IK_CONFIG_ROOT, ASSET_ROOT, ROBOT_XML_DICT, IK_CONFIG_DICT, ROBOT_BASE_DICT, VIEWER_CAM_DISTANCE_DICT
from .motion_retarget import GeneralMotionRetargeting
from .robot_motion_viewer import RobotMotionViewer, draw_frame
from .data_loader import load_robot_motion
from .kinematics_model import KinematicsModel

from .neck_retarget import human_head_to_robot_neck

try:
    from .xrobot_utils import XRobotStreamer, XRobotRecorder
except ImportError:
    print("XRobotStreamer is not installed. Please install xrobotoolkit_sdk to use this feature.")
    XRobotStreamer = None
    XRobotRecorder = None


