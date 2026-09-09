/**
 * DSH Cat Meme Desktop Pet Plugin - Client Half
 *
 * 在Web界面右下角显示猫MEME宠物UI组件
 */


export function apply(ctx) {
  const slots = ctx.get('slots')
  if (!slots) return

  // 插入样式
  const css = `
    .cat-pet-overlay {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 9999;
      pointer-events: none;
      user-select: none;
    }
    .cat-pet-container {
      pointer-events: auto;
      cursor: pointer;
      transition: transform 0.3s ease;
    }
    .cat-pet-container:hover {
      transform: scale(1.1);
    }
    .cat-pet-image {
      width: 120px;
      height: 120px;
      object-fit: contain;
      filter: drop-shadow(0 4px 8px rgba(0,0,0,0.3));
      animation: bounce 2s infinite ease-in-out;
    }
    .cat-pet-image.running {
      animation: working 0.5s infinite ease-in-out;
    }
    .cat-pet-image.celebrating {
      animation: celebrate 0.6s ease-in-out;
    }
    @keyframes bounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-10px); }
    }
    @keyframes working {
      0%, 100% { transform: rotate(-5deg); }
      50% { transform: rotate(5deg); }
    }
    @keyframes celebrate {
      0% { transform: scale(1) rotate(0deg); }
      25% { transform: scale(1.2) rotate(-10deg); }
      50% { transform: scale(1.2) rotate(10deg); }
      75% { transform: scale(1.1) rotate(-5deg); }
      100% { transform: scale(1) rotate(0deg); }
    }
    .cat-pet-bubble {
      position: absolute;
      bottom: 130px;
      right: 60px;
      background: white;
      padding: 8px 12px;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      font-size: 14px;
      white-space: nowrap;
      opacity: 0;
      transition: opacity 0.3s;
    }
    .cat-pet-bubble.show {
      opacity: 1;
    }
  `
  const styleDisposer = ctx.styles.insert(css)

  // 猫的表情数据（使用公共的猫MEME图片）
  const catImages = {
    idle: 'https://i.imgflip.com/2/345v97.jpg',
    running: 'https://i.imgflip.com/2/34bly.jpg',
    celebrate: 'https://i.imgflip.com/2/34ha6.jpg'
  }

  // 音效（使用公共音效）
  const completeSound = 'https://www.myinstants.com/media/sounds/mario-coin-sound.mp3'

  // 播放声音函数
  function playCompleteSound() {
    const audio = new Audio(completeSound)
    audio.volume = 0.3
    audio.play().catch(() => {
      console.log('Audio play failed (user interaction required)')
    })
  }

  // 主组件
  function CatPetComponent() {
    const [status, setStatus] = React.useState('idle')
    const [celebrate, setCelebrate] = React.useState(false)
    const [bubble, setBubble] = React.useState({ show: false, text: '' })

    React.useEffect(() => {
      let mounted = true

      const updateStatus = async () => {
        if (!mounted) return
        try {
          const result = await host.call('queryPetStatus')
          if (result && result.status && mounted) {
            setStatus(result.status)
            updateBubble(result.status)
          }
        } catch (e) {
          console.log('Query pet status failed:', e)
        }
      }

      // 初始查询
      updateStatus()

      // 定期轮询状态
      const interval = setInterval(updateStatus, 2000)

      return () => {
        mounted = false
        clearInterval(interval)
      }
    }, [])

    function updateBubble(newStatus) {
      const messages = {
        idle: '喵~ 在休息中',
        running: '工作中...'
      }
      setBubble({ show: true, text: messages[newStatus] || '' })
    }

    function handleClick() {
      setBubble({ show: true, text: '喵！' })
      setTimeout(() => {
        setBubble({ show: false, text: '' })
      }, 2000)
    }

    function handleTaskComplete() {
      setCelebrate(true)
      playCompleteSound()
      setBubble({ show: true, text: '任务完成！' })
      setTimeout(() => {
        setCelebrate(false)
        setBubble({ show: false, text: '' })
      }, 1500)
    }

    const imageUrl = celebrate ? catImages.celebrate : catImages[status] || catImages.idle
    const imageClass = celebrate ? 'cat-pet-image celebrating' : (status === 'running' ? 'cat-pet-image running' : 'cat-pet-image')

    return React.createElement('div', { className: 'cat-pet-overlay' },
      React.createElement('div', { className: 'cat-pet-container', onClick: handleClick },
        React.createElement('img', {
          src: imageUrl,
          alt: 'Cat Pet',
          className: imageClass
        }),
        React.createElement('div', {
          className: 'cat-pet-bubble' + (bubble.show ? ' show' : '')
        }, bubble.text)
      )
    )
  }

  // 注册到shell.overlay
  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'cat-pet-desktop-pet', order: 1000 },
    () => React.createElement(CatPetComponent)
  ))

  // 清理样式
  ctx.effect(() => {
    return () => {
      styleDisposer()
    }
  })
}