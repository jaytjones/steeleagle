'use client'

interface AddCellButtonProps {
  disabled: boolean
  onClick: () => void
}

export default function AddCellButton({ disabled, onClick }: AddCellButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? 'Maximum 10 cells' : 'Add cell'}
      className={`
        bg-slate-900/30 border border-dashed rounded-xl
        flex flex-col items-center justify-center
        min-h-[400px] transition-all
        ${
          disabled
            ? 'border-slate-800 cursor-not-allowed opacity-40'
            : 'border-slate-700 hover:border-slate-600 hover:bg-slate-900/60 cursor-pointer'
        }
      `}
    >
      <span className="text-5xl text-slate-500 font-thin mb-2">+</span>
      <span className="text-slate-600 text-xs font-mono tracking-widest uppercase">
        {disabled ? 'Max 10 cells' : 'Add cell'}
      </span>
    </button>
  )
}