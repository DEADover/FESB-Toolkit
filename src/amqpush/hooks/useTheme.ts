import { useEffect, useState } from 'react'

/**
 * Тема раздела — это тема приложения.
 *
 * В отдельном приложении у AMQPush был свой переключатель и свой ключ
 * в хранилище браузера. Здесь тему выбирают в шапке FESB Toolkit, а на
 * `<html>` стоит `data-theme`. Раздел за ним просто следит: редактору тела
 * сообщения нужно знать, светло сейчас или темно, чтобы выбрать подсветку.
 */
export function useTheme(): { effective: 'light' | 'dark' } {
  const [effective, setEffective] = useState<'light' | 'dark'>(current)

  useEffect(() => {
    // Наблюдатель, а не подписка на хозяйское состояние: раздел не должен
    // знать, как приложение хранит тему, — достаточно того, что она
    // написана на корневом элементе.
    const watcher = new MutationObserver(() => setEffective(current()))
    watcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => watcher.disconnect()
  }, [])

  return { effective }
}

function current(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}
