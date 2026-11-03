# Extend the same immutable environment used by SDK; never install on the runner host.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends nodejs libgl1 libegl1 libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
RUN python -m pip install --timeout 300 --retries 3 --index-url https://download.pytorch.org/whl/cpu torch==2.9.1
COPY ci/build-requirements.txt /opt/component-ci/requirements.txt
RUN python -m pip install --timeout 300 --retries 3 -r /opt/component-ci/requirements.txt \
    && python -m pip check
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1
ENTRYPOINT []
