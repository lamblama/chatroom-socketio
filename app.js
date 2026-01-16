/*
    启动服务端程序
*/
const app = require('express')()
const server = require('http').Server(app)
const io = require('socket.io')(server)
const path = require('path');
const db = require('./db/db.js')
const chinaTime = require('china-time')



//记录所有已经登陆过的用户
const users = []
var id_now = 1

//启动了服务器
server.listen(3000, () => {
    console.log('服务器启动成功了，访问 http://localhost:3000 即可')
})

//express处理静态资源
//把public目录设置为静态资源
app.use(require('express').static(path.join(__dirname, 'public')))
app.get('/', function (req, res) {
    res.redirect('/index.html')
})

db.selectAll('select count(*) as sum from message', (e, r) => {
    //id 按照消息发送的先后顺序递增
    console.log('数据库共有' + r[0].sum + '条历史消息记录')
    id_now = r[0].sum + 1
})

//一进入聊天室就加载群聊信息
function initGroupMessage(socket) {
    db.selectAll('select * from message order by id asc', (e, res) => {
        for (var i = 0; i < res.length; i++) {
            if(res[i].type ==='image') {
                socket.emit('receiveImage', res[i])
            }else{
                socket.emit('receiveMessage', res[i])
            }
        }
    })
}

//加载私聊历史消息
function initPrivateMessage(socket, fromUser, toUser) {
    // 查询双方的私聊记录（A发给B + B发给A）
    const sql = `SELECT * FROM private_message 
                 WHERE (from_user = '${fromUser}' AND to_user = '${toUser}') 
                    OR (from_user = '${toUser}' AND to_user = '${fromUser}') 
                 ORDER BY id ASC`;
    db.selectAll(sql, (e, res) => {
        if (e) {
            console.log('查询私聊历史失败：', e);
            socket.emit('privateHistory', { msgs: [] });
            return;
        }
        // 新增：模仿群聊的for循环，按消息类型逐个推送（和群聊逻辑对齐）
        for (var i = 1; i < res.length; i++) {
            // 区分私聊消息类型（文本/图片），和群聊的receiveImage/receiveMessage事件对齐
            if(res[i].type === 'image') {
                // 推送私聊图片历史消息（事件名可复用或自定义，这里保持和群聊一致易维护）
                socket.emit('receivePrivateImage', res[i]);
            } else {
                // 推送私聊文本历史消息
                socket.emit('receivePrivateMsg', res[i]);
            }
        }
       
    });
}

io.on('connection', function (socket) {
    // 登录验证
    socket.on('checkoutLogin', data => {
        let msg = '', resultData = '';
        db.selectAll("select * from usersInformation where username ='" + data.username + "' ", (e, r) => {
            let tt = r.length;
            if (tt == 0) {
                msg = "用户名不存在";
            } else if (data.password != r[0].password) {
                msg = "用户密码错误";
            } else {
                resultData = r[0];
                msg = "用户密码正确"
            }
            socket.emit('checkoutAnswer', {
                msg: msg,
                avatar: resultData.avatar
            })
        })
    })

    // 登录逻辑
    socket.on('login', data => {
        let user = users.find(item => item.username === data.username)
        if (user) {
            socket.emit('loginError', { msg: '登陆失败，用户名已在线' })
        } else {
            socket.username = data.username
            socket.avatar = data.avatar
            users.push(data)
            socket.emit('loginSuccess', data)
            io.emit('addUser', data)
            io.emit('userList', users)
            // 登录后默认加载群聊消息
            initGroupMessage(socket)
        }
    })

    // 用户断开连接
    socket.on('disconnect', () => {
        if(!socket.username) return
        let idx = users.findIndex(item => item.username === socket.username)
        if(idx > -1) {
            users.splice(idx, 1)
            io.emit('deleteUser', {
                username: socket.username,
                avatar: socket.avatar
            })
            io.emit('userList', users)
        }
    })

    // 发送群聊文本消息
    socket.on('sendMessage', data => {
        var time = chinaTime('YY/MM/DD HH:mm')
        let saveData = {
            id: id_now,
            username: data.username,
            content: data.content,
            time: time,
            avatar: data.avatar,
            type: data.type || 'text'
        }
        db.insertData('message', saveData, (e, r) => {
            id_now++
        })
        // 广播给所有用户（群聊）
        io.emit('receiveMessage', saveData)
    })

    // 发送群聊图片消息
    socket.on('sendImage', data => {
        var time = chinaTime('YY/MM/DD HH:mm')
        let saveData = {
            id: id_now,
            username: data.username,
            content: data.img,
            time: time,
            avatar: data.avatar,
            type: 'image'
        }
        db.insertData('message', saveData, (e, r) => {
            id_now++
        })
        // 广播给所有用户（群聊）
        io.emit('receiveImage', saveData)
    })

    // 恢复截图功能（完善版）
    const puppeteer = require('puppeteer');
    const fs = require('fs');
    const screenshotDir = path.join(__dirname, 'public', 'images');
    if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
}
    // 核心：接收前端传的base64截图，直接保存（无需访问URL，无登录态问题）
socket.on('webshotByBase64', async (data) => {
  const { base64, username, avatar } = data;
  const filename = `screenshot_${username}_${Date.now()}.png`;
  const savePath = path.join(screenshotDir, filename); // 你的截图保存目录，和之前一致

  try {
    // 1. 解码base64（去掉前缀，只保留纯base64内容）
    const base64Data = base64.replace(/^data:image\/png;base64,/, '');
    
    // 2. 同步保存图片到本地（确保截图目录存在）
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }
    fs.writeFileSync(savePath, base64Data, 'base64');

    // 3. 构造图片访问URL（和你之前的逻辑一致）
    const imgUrl = `/images/${filename}`; // 确保/images目录被静态托管

    // 4. 告诉前端截图成功
    socket.emit('webshotSuccess', { imgPath: imgUrl });

    // 5. 保存到数据库（和你之前的入库逻辑一致）
    var time = chinaTime('YY/MM/DD HH:mm');
    let saveData = {
      id: id_now,
      username: username,
      content: imgUrl,
      time: time,
      avatar: avatar,
      type: 'image'
    };
    // 插入数据库（你的db.insertData逻辑不变）
    db.insertData('message', saveData, (e, r) => {
      id_now++;
    });
    // 广播给所有用户显示截图
    io.emit('receiveImage', saveData);

  } catch (err) {
    console.error('保存截图失败：', err);
    socket.emit('webshotError', { msg: '截图保存失败：' + err.message });
  }
});

    // 注册用户
    socket.on('registerUser', data => {
        db.selectAll("select * from usersInformation where username = '" + data.username + "' ", (e, r) => {
            let tt = r.length;
            if (tt == 1) {
                socket.emit('registerError', { msg: '账号已经被注册' })
            } else {
                db.insertData('usersInformation', data, (e, r) => {
                    socket.emit('registerSuccess', { msg: '注册成功' })
                })
            }
        })
    })

    // ========== 新增私聊核心逻辑 ==========
    // 1. 发起私聊（加载私聊历史）
    socket.on('privateChatInit', (data) => {
        const { fromUser, toUser } = data;
        // 记录当前私聊的对象
        socket.currentPrivateTarget = toUser;
        // 加载私聊历史
        initPrivateMessage(socket, fromUser, toUser);
    })

    // 2. 发送私聊文本消息
   socket.on('sendPrivateMsg', (data) => {
  console.log('收到私聊请求：', data);
  const time = chinaTime('YY/MM/DD HH:mm');
  const saveData = {
    from_user: data.fromUser,
    to_user: data.toUser,
    content: data.content,
    time: time,
    avatar: data.avatar,
    type: 'text'
  };
  
  db.insertData('private_message', saveData, (e, r) => {
    if (e) {
      console.error('私聊消息存入失败：', e);
      socket.emit('privateMsgError', { msg: '私聊消息发送失败' });
      return;
    }
    console.log('私聊消息存入成功：', saveData);
    
    // ========== 修复：确保发送方和接收方都能收到消息 ==========
    // 1. 给“发送方”推送消息（自己发的消息）
    socket.emit('receivePrivateMsg', saveData);
    
    // 2. 遍历所有在线用户的Socket，找到“接收方”并推送消息
    io.sockets.sockets.forEach((client) => {
      // 匹配接收方的用户名
      if (client.username === data.toUser) {
        client.emit('receivePrivateMsg', saveData);
      }
    });
  });
});

    // 3. 发送私聊图片消息
    socket.on('sendPrivateImage', (data) => {
        const time = chinaTime('YY/MM/DD HH:mm');
        const saveData = {
            from_user: data.fromUser,
            to_user: data.toUser,
            content: data.img,
            time: time,
            avatar: data.avatar,
            type: 'image'
        };
        // 存入私聊表
        db.insertData('private_message', saveData, (e, r) => {
            if (e) {
                socket.emit('privateMsgError', { msg: '私聊图片发送失败' });
                return;
            }
            // 找到接收方的socket连接
            const toSocket = Array.from(io.sockets.sockets.values()).find(s => s.username === data.toUser);
            // 给发送方推送私聊图片
            socket.emit('receivePrivateImage', saveData);
            // 给接收方推送私聊图片（如果在线）
            if (toSocket) {
                toSocket.emit('receivePrivateImage', saveData);
            }
        });
    })

    // 4. 切换回群聊
    socket.on('switchToGroupChat', () => {
        socket.currentPrivateTarget = null;
        // 重新加载群聊消息
        initGroupMessage(socket);
    })
})