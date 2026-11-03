from stage import build

COMPONENT = 'gmr'
DISTRIBUTION = 'general-motion-retargeting'


def build_wheel(root, work, output, version):
    build(root, work, output, version, ['setup.py', 'README.md', 'LICENSE', 'general_motion_retargeting', 'third_party', 'assets'])


def supplemental_files(root, work):
    return {}
