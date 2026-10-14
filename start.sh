#!/bin/bash

#poetry run python label_studio/manage.py runserver 0.0.0.0:8099

LABEL_STUDIO_LOCAL_FILES_SERVING_ENABLED=true LABEL_STUDIO_LOCAL_DOCUMENT_ROOT=/home/disk/labelstudio/data LABEL_STUDIO_PORT=8099 poetry run label-studio


