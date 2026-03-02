import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

interface ThemeToggleProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export const ThemeToggle: React.FC<ThemeToggleProps> = ({ 
  className = '',
  size = 'md'
}) => {
  const { theme, toggleTheme } = useTheme();
  
  const sizeClasses = {
    sm: 'w-8 h-8 p-1.5',
    md: 'w-10 h-10 p-2',
    lg: 'w-12 h-12 p-2.5'
  };

  const iconSize = {
    sm: 16,
    md: 20,
    lg: 24
  };

  return (
    <button
      onClick={toggleTheme}
      className={`
        ${sizeClasses[size]}
        rounded-full
        bg-white/10
        hover:bg-white/20
        border border-white/20
        hover:border-white/40
        transition-all
        duration-300
        flex
        items-center
        justify-center
        shadow-lg
        backdrop-blur-sm
        ${className}
      `}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? (
        <Sun 
          size={iconSize[size]} 
          className="text-yellow-400 transition-transform duration-300 hover:rotate-45" 
        />
      ) : (
        <Moon 
          size={iconSize[size]} 
          className="text-indigo-600 transition-transform duration-300 hover:-rotate-45" 
        />
      )}
    </button>
  );
};

// 主题选择器下拉菜单
export const ThemeSelector: React.FC = () => {
  const { theme, setTheme } = useTheme();

  const themes = [
    { id: 'dark', name: 'Dark Night', icon: Moon },
    { id: 'light', name: 'Light Day', icon: Sun }
  ];

  return (
    <div className="relative">
      <div className="flex flex-col gap-2 p-4 bg-card/80 backdrop-blur-xl border border-border rounded-2xl shadow-xl">
        <h3 className="text-sm font-bold uppercase tracking-widest text-text-muted mb-3">
          Theme Selector
        </h3>
        <div className="grid grid-cols-2 gap-3">
          {themes.map((t) => {
            const Icon = t.icon;
            const isActive = theme === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTheme(t.id as any)}
                className={`
                  p-4 rounded-xl border-2 transition-all duration-300
                  flex flex-col items-center gap-2
                  ${isActive 
                    ? 'border-accent bg-accent/10 shadow-lg shadow-accent/20' 
                    : 'border-border hover:border-white/30 bg-white/5 hover:bg-white/10'
                  }
                `}
              >
                <Icon 
                  size={24} 
                  className={isActive 
                    ? 'text-accent' 
                    : 'text-text-muted group-hover:text-white'
                  } 
                />
                <span className={`
                  text-xs font-bold uppercase tracking-wider
                  ${isActive ? 'text-accent' : 'text-text-muted'}
                `}>
                  {t.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};