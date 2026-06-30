import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getCanvasBackingPixelRatio,
  measureCanvasResizeState,
} from './canvasSizing.ts'

interface FakeMeasuredElement {
  __uiScale?: string
  clientWidth: number
  clientHeight: number
  offsetWidth: number
  offsetHeight: number
  ownerDocument: {
    defaultView: {
      getComputedStyle: (element: FakeMeasuredElement) => { getPropertyValue: (propertyName: string) => string }
    }
  }
  getBoundingClientRect: () => never
}

interface FakeCanvasElement extends FakeMeasuredElement {
  width: number
  height: number
  style: {
    width: string
    height: string
  }
}

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')

function installWindow(devicePixelRatio: number): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      devicePixelRatio,
      getComputedStyle: (element: FakeMeasuredElement) => ({
        getPropertyValue: (propertyName: string) => propertyName === '--ui-scale'
          ? element.__uiScale ?? ''
          : '',
      }),
    },
  })
}

function restoreWindow(): void {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'window')
  }
}

function createMeasuredElement(
  clientWidth: number,
  clientHeight: number,
  uiScale?: string,
): FakeMeasuredElement {
  const element = {
    __uiScale: uiScale,
    clientWidth,
    clientHeight,
    offsetWidth: clientWidth,
    offsetHeight: clientHeight,
    ownerDocument: {
      defaultView: {
        getComputedStyle: (target: FakeMeasuredElement) => ({
          getPropertyValue: (propertyName: string) => propertyName === '--ui-scale'
            ? target.__uiScale ?? ''
            : '',
        }),
      },
    },
    getBoundingClientRect: () => {
      throw new Error('transformed layout measurement should not be used')
    },
  }

  return element
}

test('canvas resize measurement uses untransformed layout size and UI scale for backing pixels', () => {
  installWindow(1)

  try {
    const element = createMeasuredElement(400, 100, '1.2')
    const size = measureCanvasResizeState(element as unknown as HTMLElement)

    assert.equal(size.cssWidth, 400)
    assert.equal(size.cssHeight, 100)
    assert.equal(size.dpr, 1.2)
    assert.equal(size.pixelWidth, 480)
    assert.equal(size.pixelHeight, 120)
  } finally {
    restoreWindow()
  }
})

test('canvas resize measurement falls back to OS DPR for missing or invalid UI scale', () => {
  installWindow(2)

  try {
    const invalidScale = measureCanvasResizeState(createMeasuredElement(320, 80, 'bogus') as unknown as HTMLElement)
    assert.equal(invalidScale.dpr, 2)
    assert.equal(invalidScale.pixelWidth, 640)
    assert.equal(invalidScale.pixelHeight, 160)

    const missingScale = measureCanvasResizeState(createMeasuredElement(320, 80) as unknown as HTMLElement)
    assert.equal(missingScale.dpr, 2)
    assert.equal(missingScale.pixelWidth, 640)
    assert.equal(missingScale.pixelHeight, 160)
  } finally {
    restoreWindow()
  }
})

test('canvas backing ratio prefers the actual backing-store-to-css-size ratio', () => {
  installWindow(1)

  try {
    const canvas = {
      ...createMeasuredElement(400, 100, '1.2'),
      width: 480,
      height: 120,
      style: {
        width: '400px',
        height: '100px',
      },
    } satisfies FakeCanvasElement

    assert.equal(getCanvasBackingPixelRatio(canvas as unknown as HTMLCanvasElement), 1.2)
  } finally {
    restoreWindow()
  }
})
