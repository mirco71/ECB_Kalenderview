/**
 * API helper — centralizes all fetch calls to the backend.
 */
const API = {
  baseUrl: '',

  /**
   * Get auth token from localStorage
   */
  getToken() {
    return localStorage.getItem('ecb_token');
  },

  /**
   * Make an authenticated request
   */
  async request(method, path, body = null) {
    const headers = { 'Content-Type': 'application/json' };
    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const options = { method, headers };
    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(this.baseUrl + path, options);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    return data;
  },

  // ============ AUTH ============

  async login(username, password) {
    const data = await this.request('POST', '/api/auth/login', { username, password });
    localStorage.setItem('ecb_token', data.token);
    localStorage.setItem('ecb_user', JSON.stringify(data.user));
    return data;
  },

  logout() {
    localStorage.removeItem('ecb_token');
    localStorage.removeItem('ecb_user');
  },

  async me() {
    return this.request('GET', '/api/auth/me');
  },

  getStoredUser() {
    const raw = localStorage.getItem('ecb_user');
    return raw ? JSON.parse(raw) : null;
  },

  isLoggedIn() {
    return !!this.getToken();
  },

  // ============ EVENTS ============

  async getEvents(startISO, endISO) {
    return this.request('GET', `/api/events?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`);
  },

  async createEvent(eventData) {
    return this.request('POST', '/api/events', eventData);
  },

  async updateEvent(id, eventData) {
    return this.request('PUT', `/api/events/${id}`, eventData);
  },

  async deleteEvent(id) {
    return this.request('DELETE', `/api/events/${id}`);
  },

  // ============ SERIES ============

  async createSeries(data) {
    return this.request('POST', '/api/events/series', data);
  },

  async getSeries(seriesId) {
    return this.request('GET', `/api/events/series/${seriesId}`);
  },

  async updateSeries(seriesId, data) {
    return this.request('PUT', `/api/events/series/${seriesId}`, data);
  },

  async deleteEventSeries(seriesId) {
    return this.request('DELETE', `/api/events/series/${seriesId}`);
  },

  // ============ CATEGORIES ============

  async getCategories() {
    return this.request('GET', '/api/categories');
  },

  async createCategory(data) {
    return this.request('POST', '/api/categories', data);
  },

  async updateCategory(id, data) {
    return this.request('PUT', `/api/categories/${id}`, data);
  },

  async deleteCategory(id) {
    return this.request('DELETE', `/api/categories/${id}`);
  },

  // ============ USERS ============

  async getUsers() {
    return this.request('GET', '/api/users');
  },

  async createUser(data) {
    return this.request('POST', '/api/users', data);
  },

  async updateUser(id, data) {
    return this.request('PUT', `/api/users/${id}`, data);
  },

  async deleteUser(id) {
    return this.request('DELETE', `/api/users/${id}`);
  },

  // ============ CONFIG ============

  async getConfig() {
    return this.request('GET', '/api/config');
  },
};
