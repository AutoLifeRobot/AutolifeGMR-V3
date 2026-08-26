import os
import sys
import sysconfig
import platform
from setuptools import setup, find_packages

is_windows = platform.system() == 'Windows'
is_linux = platform.system() == 'Linux'
is_macos = platform.system() == 'Darwin'

# Set the classifiers based on the operating system
classifiers = [
    f"Programming Language :: Python :: {sys.version_info.major}.{sys.version_info.minor}",
]
if is_windows:
    classifiers.append("Operating System :: Microsoft :: Windows")
if is_linux:
    classifiers.append("Operating System :: POSIX :: Linux")
if is_macos:
    classifiers.append("Operating System :: MacOS :: MacOS X")

def add_extra_data_dir(directory):
    paths = []
    for (path, directories, filenames) in os.walk(directory):
        for filename in filenames:
            folder_prefix = ''
            if is_windows:
                folder_prefix = f'Lib/site-packages/general_motion_retargeting'
            elif is_linux:
                folder_prefix = f'lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages/general_motion_retargeting'
            elif is_macos:
                folder_prefix = f'lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages/general_motion_retargeting'
            else:
                raise NotImplementedError(
                    f"Unsupported operating system: {platform.system()}")
            paths.append((os.path.join(folder_prefix, path),
                         [os.path.join(path, filename)]))
    return paths

setup(
  name = 'general_motion_retargeting',
  packages = find_packages(),
  author="Yanjie Ze",
  author_email="lastyanjieze@gmail.com",
  description="General Motion Retargeting (GMR) for Humanoid Robots",
  long_description=open("README.md").read(),
  long_description_content_type="text/markdown",
  url="https://github.com/YanjieZe/GMR",
  license="MIT",
  version="0.2.0",
  install_requires=[
    "loop_rate_limiters",
    "mink",
    "mujoco",
    "numpy",
    "scipy",
    "qpsolvers[proxqp]",
    "rich",
    "tqdm",
    "opencv-python",
    "natsort",
    "psutil",
    "smplx @ git+https://github.com/vchoutas/smplx",
    "protobuf",
    "redis[hiredis]",
    "imageio[ffmpeg]",
  ],
  python_requires='>=3.10',
  include_package_data=True,
  data_files=[
      *add_extra_data_dir('assets'),
      *add_extra_data_dir('general_motion_retargeting/ik_configs')
  ]
)
