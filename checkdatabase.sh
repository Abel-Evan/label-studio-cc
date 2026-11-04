poetry run python label_studio/manage.py shell -c '
from django.conf import settings

db = settings.DATABASES["default"]
print("ENGINE =", db["ENGINE"])
print("NAME   =", db["NAME"])
print("USER   =", db["USER"])
print("HOST   =", db["HOST"])
print("PORT   =", db["PORT"])
'
