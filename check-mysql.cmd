@echo off
sc query type= service state= all | findstr /i "mysql" > check-mysql-output.txt 2>&1
echo DONE >> check-mysql-output.txt