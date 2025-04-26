import React from 'react';
import ReactDOM from 'react-dom/client';
import FilePizzaComponent from './FilePizzaComponent';
import './styles.css';

document.addEventListener('DOMContentLoaded', () => {
  const rootElement = document.getElementById('root');
  if (rootElement) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(
      <React.StrictMode>
        <FilePizzaComponent />
      </React.StrictMode>
    );
  }
});