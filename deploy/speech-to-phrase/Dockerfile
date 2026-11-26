# Speech-to-Phrase 2.x for Sanctum: speech to text that knows only the
# sentences it was taught, on plain Debian. It is upstream's Wyoming server
# from a pinned commit, with Sanctum's entry point (sanctum_server.py) in
# place of Home Assistant's add-on: no web UI, no Home Assistant, and the
# sentences come from the core over Wyoming. See README.md.

FROM debian:trixie-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

WORKDIR /usr/src
ENV VIRTUAL_ENV="/usr/src/.venv"
ENV PATH="${VIRTUAL_ENV}/bin:${PATH}"
ENV PYTHONUNBUFFERED=1

# Upstream's add-on folder at a pinned commit: its sources (src/), the
# recognition library it vendors (lib/), and its requirements.
ADD https://github.com/OHF-Voice/apps.git#6c2ae7f0dfbde74ad926d15dc865c085d0255c50:speech-to-phrase /usr/src

# The compilers build the library's native module and leave in the same
# layer, keeping the OpenFST runtime the module links: every shared library
# it loads is marked as wanted before the purge, and importing it afterwards
# fails the build if one went missing.
RUN \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        netcat-traditional \
        python3 \
        python3-pip \
        python3-venv \
    && apt-get install -y --no-install-recommends \
        cmake \
        g++ \
        libfst-dev \
        python3-dev \
    && python3 -m venv "${VIRTUAL_ENV}" \
    && "${VIRTUAL_ENV}/bin/python3" -m pip install --no-cache-dir -r requirements.txt \
    && fst_so="$("${VIRTUAL_ENV}/bin/python3" -c 'import glob, pathlib, speech_to_phrase as s; print(glob.glob(str(pathlib.Path(s.__file__).parent / "_fst*.so"))[0])')" \
    && kept=0 \
    && for lib in $(ldd "$fst_so" | awk '/=> \// {print $3}'); do \
           pkg="$(dpkg -S "$(readlink -f "$lib")" 2>/dev/null | cut -d: -f1 | head -1)"; \
           if [ -n "$pkg" ]; then apt-mark manual "$pkg"; kept=$((kept + 1)); fi; \
       done \
    && if [ "$kept" -eq 0 ]; then echo "none of _fst's libraries mapped to a package" >&2; exit 1; fi \
    && apt-get purge -y --auto-remove cmake g++ libfst-dev python3-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /root/.cache \
    && "${VIRTUAL_ENV}/bin/python3" -c "import speech_to_phrase"

COPY sanctum_server.py /usr/src/sanctum_server.py

# Models download to /data the first time a language is taught, and its
# grammar stays there between starts.
VOLUME /data
EXPOSE 10300

HEALTHCHECK --start-period=2m \
    CMD echo '{ "type": "describe" }' | nc -w 1 localhost 10300 | grep -q '"asr"' || exit 1

CMD ["python3", "/usr/src/sanctum_server.py", "--data", "/data", "--uri", "tcp://0.0.0.0:10300", "--vad-silence-seconds", "0.7"]
