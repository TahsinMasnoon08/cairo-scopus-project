@echo off
cd /d "C:\Users\USER\Desktop\MJIIT Spocus Project"

start "Scopus Backend" cmd /k "node server.js"

timeout /t 10

start "" "http://localhost:5000/api/import-all-publications"

timeout /t 20

start "" "ms-powerautomate:/"

ms-powerautomate:/console/flow/run?environmentid=one-drive-environment-Id&workflowid=5ebc0d09-afe4-40c8-9bbb-4c40c4086ad0&source=Shortcut