# Paste all of this into your PythonAnywhere WSGI configuration file
# (Web tab -> "WSGI configuration file" link), replacing everything in it.
#
# Change YOUR_USERNAME below to your PythonAnywhere username.

import sys

project_folder = "/home/YOUR_USERNAME/mashaal-rent"
if project_folder not in sys.path:
    sys.path.insert(0, project_folder)

from app import application  # noqa: E402,F401
