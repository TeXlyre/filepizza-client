import React from 'react';
import ReactDOM from 'react-dom/client';
import FilePizzaComponent from './FilePizzaComponent';
import './FilePizzaComponent.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <FilePizzaComponent />
  </React.StrictMode>
);