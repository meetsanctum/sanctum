"""Print the recognition models selected by this Speech-to-Phrase image."""

import json

from sanctum_server import BACKEND, LANGUAGES, models


if __name__ == "__main__":
    recognition_models = {
        language: {"backend": BACKEND, "model": models.model_name_for(language, BACKEND)}
        for language in LANGUAGES
    }
    print(json.dumps(recognition_models, indent=2))
