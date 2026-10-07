"""Portable GMR wheel; assets are package resources, not prefix-specific data_files."""
from pathlib import Path
import shutil
from setuptools import setup, find_packages
from setuptools.command.build_py import build_py


class BuildPy(build_py):
    def run(self):
        super().run()
        target = Path(self.build_lib) / "general_motion_retargeting"
        shutil.copytree("assets", target / "assets", dirs_exist_ok=True)


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
  version="0.2.0+autolife.v3",
  install_requires=[
    "loop-rate-limiters", "mink>=1.3,<2", "mujoco>=3.3,<4", "numpy", "scipy",
    "qpsolvers[daqp]>=4,<5", "rich", "torch>=2.6,<3", "imageio", "toml",
  ],
  extras_require={
    "tools": ["qpsolvers[proxqp]", "tqdm", "opencv-python", "natsort", "psutil",
              "smplx>=0.1.28", "protobuf", "redis[hiredis]", "imageio[ffmpeg]"],
  },
  python_requires='>=3.10',
  include_package_data=True,
  package_data={"general_motion_retargeting": ["ik_configs/*.json"]},
  cmdclass={"build_py": BuildPy},
)
