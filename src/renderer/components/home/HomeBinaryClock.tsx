import { encodeBinaryClock, formatBinaryClockTime } from '../../utils/binaryClock'

interface HomeBinaryClockProps {
  date: Date
  dateLabel: string
}

export default function HomeBinaryClock({ date, dateLabel }: HomeBinaryClockProps) {
  const rows = encodeBinaryClock(date)
  const timeLabel = formatBinaryClockTime(date)
  const timeParts = [[0, 1], [2, 3], [4, 5]] as const

  return (
    <div className="home-binary-clock">
      <h1 className="home-binary-clock-heading">
        <time
          className="home-binary-clock-time"
          dateTime={date.toISOString()}
          aria-label={`Binary clock, ${timeLabel}, ${dateLabel}`}
        >
          <span className="home-binary-clock-grid" aria-hidden="true">
            {timeParts.map((digitIndices, partIndex) => (
              <span className="home-binary-clock-part" key={partIndex}>
                <span className="home-binary-clock-pair">
                  {digitIndices.map((digitIndex) => (
                    <span className="home-binary-clock-digit" key={digitIndex}>
                      {rows.map((row, bitIndex) => (
                        <span
                          className={`home-binary-clock-cell${row[digitIndex] === 1 ? ' is-on' : ''}`}
                          key={bitIndex}
                        />
                      ))}
                    </span>
                  ))}
                </span>
              </span>
            ))}
          </span>
        </time>
      </h1>
      <p className="home-greeting-subline home-binary-clock-date" aria-hidden="true">{dateLabel}</p>
    </div>
  )
}
