cd /opt/label-studio-cc

#先运行checkdatabase.sh检查数据库的配置参数对不对

#如果不对运行下面的命令重新加载一遍
set -a
source /etc/label-studio-cc.env
set +a

#启动服务的命令
nohup ./start.sh > /opt/label-studio-cc/start.log 2>&1 < /dev/null &

echo $! > /opt/label-studio-cc/start.pid

echo "Label Studio 后台启动，PID=$(cat /opt/label-studio-cc/start.pid)"

#或者直接启动不保存日志
nohup ./start.sh  &

