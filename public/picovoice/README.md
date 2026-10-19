Only needed if you set PICOVOICE_ACCESS_KEY in your settings (`npm run settings`, or .env.local).

Put Picovoice's `porcupine_params.pv` here (Apache 2.0):

    curl -L -o public/picovoice/porcupine_params.pv \
      https://github.com/Picovoice/porcupine/raw/master/lib/common/porcupine_params.pv

Without a key, Jarvis uses Chrome's on-device recogniser or push-to-talk instead.
